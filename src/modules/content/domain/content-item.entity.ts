import {
  DomainError,
  validationError,
} from '../../../shared/domain/domain-error.js';
import type {
  AIAttribution,
  ContentStatus,
  ContentType,
  ContentVersionSource,
  SourceMetadata,
} from './content-types.js';

export interface ContentVersionRecord {
  version: number;
  title: string;
  body: string;
  scripture: string | null;
  source: ContentVersionSource;
  aiProvider: string | null;
  aiModel: string | null;
  createdAt: Date;
}

export interface ContentItemProps {
  id: string;
  churchId: string;
  sermonId: string;
  generationJobId: string | null;
  type: ContentType;
  position: number;
  title: string;
  body: string;
  scripture: string | null;
  platform: string | null;
  status: ContentStatus;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  sourceMetadata: SourceMetadata;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentPatch {
  title?: string;
  body?: string;
  scripture?: string | null;
}

const contentLocked = () =>
  new DomainError(
    'UNPROCESSABLE',
    'CONTENT_LOCKED',
    'Published or archived content cannot be changed.',
  );

/**
 * Content lifecycle: DRAFT → APPROVED → SCHEDULED → PUBLISHED (or FAILED).
 * Every change to title/body creates a new version; history is never rewritten.
 */
export class ContentItem {
  private readonly newVersions: ContentVersionRecord[] = [];

  private constructor(private props: ContentItemProps) {}

  static generate(input: {
    id: string;
    churchId: string;
    sermonId: string;
    generationJobId: string | null;
    type: ContentType;
    position: number;
    title: string;
    body: string;
    scripture: string | null;
    sourceMetadata: SourceMetadata;
    ai: AIAttribution;
    now: Date;
  }): ContentItem {
    const item = new ContentItem({
      id: input.id,
      churchId: input.churchId,
      sermonId: input.sermonId,
      generationJobId: input.generationJobId,
      type: input.type,
      position: input.position,
      title: validTitle(input.title),
      body: validBody(input.body),
      scripture: input.scripture,
      platform: null,
      status: 'DRAFT',
      scheduledAt: null,
      publishedAt: null,
      sourceMetadata: input.sourceMetadata,
      currentVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
    item.recordVersion('AI_GENERATED', input.ai, input.now);
    return item;
  }

  static restore(props: ContentItemProps): ContentItem {
    return new ContentItem({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get churchId(): string {
    return this.props.churchId;
  }
  get sermonId(): string {
    return this.props.sermonId;
  }
  get type(): ContentType {
    return this.props.type;
  }
  get status(): ContentStatus {
    return this.props.status;
  }
  get position(): number {
    return this.props.position;
  }
  get title(): string {
    return this.props.title;
  }
  get body(): string {
    return this.props.body;
  }
  get scripture(): string | null {
    return this.props.scripture;
  }
  get sourceMetadata(): SourceMetadata {
    return this.props.sourceMetadata;
  }

  snapshot(): Readonly<ContentItemProps> {
    return { ...this.props };
  }

  /** Versions created since load; the repository appends them. */
  pendingVersions(): readonly ContentVersionRecord[] {
    return this.newVersions;
  }

  /**
   * User edit. Approved/scheduled/failed content returns to DRAFT and must be re-approved.
   * Returns true when the caller must remove the item's calendar entry.
   */
  edit(patch: ContentPatch, now: Date): { unschedule: boolean } {
    return this.revise(patch, 'USER_EDIT', null, now);
  }

  /** AI rewrite/regeneration: persists immediately as the new current version. */
  applyAIRevision(
    content: Required<ContentPatch>,
    source: 'AI_REWRITE' | 'AI_GENERATED',
    ai: AIAttribution,
    now: Date,
    sourceMetadata?: SourceMetadata,
  ): { unschedule: boolean } {
    const result = this.revise(content, source, ai, now);
    if (sourceMetadata) this.props.sourceMetadata = sourceMetadata;
    return result;
  }

  /** Restoring copies an old version forward as a new USER_EDIT version. */
  restoreVersion(
    version: ContentVersionRecord,
    now: Date,
  ): { unschedule: boolean } {
    return this.revise(
      {
        title: version.title,
        body: version.body,
        scripture: version.scripture,
      },
      'USER_EDIT',
      null,
      now,
    );
  }

  /**
   * Idempotent. Re-approving content whose publish failed clears its schedule, so the caller
   * must remove the stale calendar entry and the item reappears as "ready to schedule".
   */
  approve(now: Date): { unschedule: boolean } {
    this.assertMutable();
    if (this.props.status === 'APPROVED' || this.props.status === 'SCHEDULED')
      return { unschedule: false };
    const unschedule = this.props.status === 'FAILED';
    if (unschedule) this.props.scheduledAt = null;
    this.props.status = 'APPROVED';
    this.props.updatedAt = now;
    return { unschedule };
  }

  schedule(at: Date, now: Date): void {
    if (this.props.status !== 'APPROVED' && this.props.status !== 'SCHEDULED') {
      throw new DomainError(
        'UNPROCESSABLE',
        'CONTENT_NOT_APPROVED',
        'Approve this content before scheduling it.',
      );
    }
    this.props.status = 'SCHEDULED';
    this.props.scheduledAt = at;
    this.props.updatedAt = now;
  }

  unschedule(now: Date): void {
    if (this.props.status === 'SCHEDULED' || this.props.status === 'FAILED')
      this.props.status = 'APPROVED';
    this.props.scheduledAt = null;
    this.props.updatedAt = now;
  }

  markPublished(at: Date): void {
    this.props.status = 'PUBLISHED';
    this.props.publishedAt = at;
    this.props.updatedAt = at;
  }

  markPublishFailed(now: Date): void {
    this.props.status = 'FAILED';
    this.props.updatedAt = now;
  }

  private revise(
    patch: ContentPatch,
    source: ContentVersionSource,
    ai: AIAttribution | null,
    now: Date,
  ): { unschedule: boolean } {
    this.assertMutable();
    if (patch.title !== undefined) this.props.title = validTitle(patch.title);
    if (patch.body !== undefined) {
      const body = validBody(patch.body);
      // Once the words change they are no longer the pastor's exact words. (Regeneration of a
      // quote supplies fresh, re-verified source metadata after this.)
      if (body !== this.props.body && this.props.sourceMetadata.verbatim) {
        this.props.sourceMetadata = {
          ...this.props.sourceMetadata,
          verbatim: false,
        };
      }
      this.props.body = body;
    }
    if (patch.scripture !== undefined)
      this.props.scripture = patch.scripture?.trim() || null;
    // Any calendar entry belongs to the approved wording; it never survives a change.
    const unschedule = this.props.status !== 'DRAFT';
    if (this.props.status !== 'DRAFT') {
      this.props.status = 'DRAFT';
      this.props.scheduledAt = null;
    }
    this.props.currentVersion += 1;
    this.recordVersion(source, ai, now);
    return { unschedule };
  }

  private recordVersion(
    source: ContentVersionSource,
    ai: AIAttribution | null,
    now: Date,
  ): void {
    this.props.updatedAt = now;
    this.newVersions.push({
      version: this.props.currentVersion,
      title: this.props.title,
      body: this.props.body,
      scripture: this.props.scripture,
      source,
      aiProvider: source === 'USER_EDIT' ? null : (ai?.provider ?? null),
      aiModel: source === 'USER_EDIT' ? null : (ai?.model ?? null),
      createdAt: now,
    });
  }

  private assertMutable(): void {
    if (this.props.status === 'PUBLISHED' || this.props.status === 'ARCHIVED')
      throw contentLocked();
  }
}

function validTitle(title: string): string {
  const value = title.trim();
  if (!value) throw validationError('title', 'Title is required');
  if (value.length > 200)
    throw validationError('title', 'Title must be at most 200 characters');
  return value;
}

function validBody(body: string): string {
  const value = body.trim();
  if (!value) throw validationError('body', 'Content cannot be empty');
  if (value.length > 20_000)
    throw validationError('body', 'Content is too long');
  return value;
}

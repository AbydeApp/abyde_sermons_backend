import { Inject, Injectable } from '@nestjs/common';
import { assertAIBudget } from '../ai-budget.js';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import {
  CHURCH_PROFILE,
  type ChurchProfilePort,
} from '../../../../shared/application/church-profile.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  DomainError,
  notFound,
} from '../../../../shared/domain/domain-error.js';
import type {
  Page,
  PageRequest,
} from '../../../../shared/domain/pagination.js';
import type {
  ContentItem,
  ContentPatch,
  ContentVersionRecord,
} from '../../domain/content-item.entity.js';
import type { ContentType, RewriteAction } from '../../domain/content-types.js';
import { type ContentView, ContentPresenter } from '../content-presenter.js';
import {
  CALENDAR_REPOSITORY,
  type CalendarRepositoryPort,
  CONTENT_QUERY,
  CONTENT_REPOSITORY,
  type ContentFilter,
  type ContentQueryPort,
  type ContentRepositoryPort,
} from '../ports/out/content-repository.port.js';
import {
  SERMON_CONTEXT,
  type SermonContextPort,
} from '../ports/out/sermon-context.port.js';
import { ContentGenerationService } from '../services/content-generation.service.js';

/** Shared helpers for single-item mutations: per-item lock, calendar cleanup, presentation. */
@Injectable()
export class ContentMutations {
  constructor(
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(CALENDAR_REPOSITORY)
    private readonly calendar: CalendarRepositoryPort,
    @Inject(CONTENT_QUERY) private readonly query: ContentQueryPort,
    @Inject(ContentPresenter) private readonly presenter: ContentPresenter,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async load(churchId: string, id: string): Promise<ContentItem> {
    const item = await this.contents.findById(churchId, id);
    if (!item) throw notFound('Content');
    return item;
  }

  /** Runs `mutate` under the item's lock, persists it and removes its calendar entry when required. */
  async mutate(
    churchId: string,
    id: string,
    mutate: (item: ContentItem) => { unschedule: boolean } | void,
  ): Promise<ContentView> {
    await this.uow.runLocked(`content:${id}`, async () => {
      const item = await this.load(churchId, id);
      const calendarItem = await this.calendar.findByContentItem(churchId, id);
      calendarItem?.assertNotPublishing();
      const result = mutate(item);
      if (result?.unschedule && calendarItem)
        await this.calendar.delete(churchId, calendarItem.id);
      await this.contents.save(item);
    });
    return this.view(churchId, id);
  }

  /**
   * Allows one AI rewrite/regeneration per item at a time. A second request while the first is
   * running is rejected, so a double-click cannot cause two billed model calls and two versions.
   */
  async exclusiveAI<T>(
    churchId: string,
    id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `content-ai:${id}`;
    if (!(await this.cache.setIfAbsent(key, 1, 180))) {
      throw new DomainError(
        'CONFLICT',
        'CONTENT_BUSY',
        'This content is already being rewritten. Please wait a moment.',
      );
    }
    try {
      await assertAIBudget(this.cache, churchId, 'edit');
      return await work();
    } finally {
      await this.cache.del(key);
    }
  }

  async siblingBodies(
    churchId: string,
    sermonId: string,
    type: ContentType,
  ): Promise<string[]> {
    const page = await this.query.list(
      churchId,
      { sermonId, type },
      { page: 1, pageSize: 100 },
    );
    return page.items.map((row) => row.body);
  }

  async view(churchId: string, id: string): Promise<ContentView> {
    const [row] = await this.query.findRows(churchId, [id]);
    if (!row) throw notFound('Content');
    const [view] = await this.presenter.present(churchId, [row]);
    if (!view) throw notFound('Content');
    return view;
  }
}

@Injectable()
export class ListContentUseCase {
  constructor(
    @Inject(CONTENT_QUERY) private readonly query: ContentQueryPort,
    @Inject(ContentPresenter) private readonly presenter: ContentPresenter,
  ) {}

  async execute(
    churchId: string,
    filter: ContentFilter,
    page: PageRequest,
  ): Promise<Page<ContentView>> {
    const result = await this.query.list(churchId, filter, page);
    return {
      ...result,
      items: await this.presenter.present(churchId, result.items),
    };
  }
}

@Injectable()
export class GetContentUseCase {
  constructor(
    @Inject(ContentMutations) private readonly mutations: ContentMutations,
  ) {}

  execute(churchId: string, id: string): Promise<ContentView> {
    return this.mutations.view(churchId, id);
  }
}

@Injectable()
export class UpdateContentUseCase {
  constructor(
    @Inject(ContentMutations) private readonly mutations: ContentMutations,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  execute(
    churchId: string,
    id: string,
    patch: ContentPatch,
  ): Promise<ContentView> {
    return this.mutations.mutate(churchId, id, (item) =>
      item.edit(patch, this.clock.now()),
    );
  }
}

@Injectable()
export class ApproveContentUseCase {
  constructor(
    @Inject(ContentMutations) private readonly mutations: ContentMutations,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  execute(churchId: string, id: string): Promise<ContentView> {
    return this.mutations.mutate(churchId, id, (item) =>
      item.approve(this.clock.now()),
    );
  }
}

const assertEditable = (item: ContentItem) => {
  if (item.status === 'PUBLISHED' || item.status === 'ARCHIVED') {
    throw new DomainError(
      'UNPROCESSABLE',
      'CONTENT_LOCKED',
      'Published or archived content cannot be changed.',
    );
  }
};

@Injectable()
export class RewriteContentUseCase {
  constructor(
    @Inject(ContentMutations) private readonly mutations: ContentMutations,
    @Inject(ContentGenerationService)
    private readonly generation: ContentGenerationService,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    churchId: string,
    id: string,
    action: RewriteAction,
  ): Promise<ContentView> {
    const current = await this.mutations.load(churchId, id);
    assertEditable(current); // fail fast before spending an AI call
    return this.mutations.exclusiveAI(churchId, id, async () => {
      const rewritten = await this.generation.rewrite(
        {
          type: current.type,
          title: current.title,
          body: current.body,
          scripture: current.scripture,
          action,
          churchId,
          sermonId: current.sermonId,
        },
        await this.profiles.findAIProfile(churchId),
      );
      return this.mutations.mutate(churchId, id, (item) =>
        item.applyAIRevision(
          {
            title: rewritten.title,
            body: rewritten.body,
            scripture: rewritten.scripture,
          },
          'AI_REWRITE',
          rewritten.ai,
          this.clock.now(),
        ),
      );
    });
  }
}

@Injectable()
export class RegenerateContentUseCase {
  constructor(
    @Inject(ContentMutations) private readonly mutations: ContentMutations,
    @Inject(ContentGenerationService)
    private readonly generation: ContentGenerationService,
    @Inject(SERMON_CONTEXT) private readonly sermons: SermonContextPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(churchId: string, id: string): Promise<ContentView> {
    const current = await this.mutations.load(churchId, id);
    assertEditable(current);
    const sermon = await this.sermons.load(churchId, current.sermonId);
    if (!sermon) throw notFound('Sermon');
    return this.mutations.exclusiveAI(churchId, id, async () => {
      // A regenerated quote must be a different quote, not this one or one of its siblings.
      const exclude =
        current.type === 'QUOTE'
          ? await this.mutations.siblingBodies(
              churchId,
              current.sermonId,
              'QUOTE',
            )
          : [];
      const output = await this.generation.generate(
        current.type,
        sermon,
        await this.profiles.findAIProfile(churchId),
        1,
        exclude,
      );
      const piece = output.pieces[0];
      if (!piece) {
        throw current.type === 'QUOTE'
          ? new DomainError(
              'UNPROCESSABLE',
              'NO_ALTERNATIVE',
              'No other exact quotes were found in this sermon.',
            )
          : new DomainError(
              'UNAVAILABLE',
              'GENERATION_FAILED',
              'We could not regenerate this content. Please try again.',
            );
      }
      return this.mutations.mutate(churchId, id, (item) =>
        item.applyAIRevision(
          { title: piece.title, body: piece.body, scripture: piece.scripture },
          'AI_GENERATED',
          output.ai,
          this.clock.now(),
          piece.sourceMetadata,
        ),
      );
    });
  }
}

@Injectable()
export class DeleteContentUseCase {
  constructor(
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(CALENDAR_REPOSITORY)
    private readonly calendar: CalendarRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(churchId: string, id: string): Promise<void> {
    await this.uow.runLocked(`content:${id}`, async () => {
      const item = await this.contents.findById(churchId, id);
      if (!item) throw notFound('Content');
      (
        await this.calendar.findByContentItem(churchId, id)
      )?.assertNotPublishing();
      await this.contents.delete(churchId, id); // calendar entry and versions cascade
    });
  }
}

@Injectable()
export class ListContentVersionsUseCase {
  constructor(
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
  ) {}

  async execute(churchId: string, id: string): Promise<ContentVersionRecord[]> {
    if (!(await this.contents.findById(churchId, id)))
      throw notFound('Content');
    return this.contents.listVersions(churchId, id);
  }
}

@Injectable()
export class RestoreContentVersionUseCase {
  constructor(
    @Inject(ContentMutations) private readonly mutations: ContentMutations,
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    churchId: string,
    id: string,
    version: number,
  ): Promise<ContentView> {
    const record = await this.contents.findVersion(churchId, id, version);
    if (!record) throw notFound('Version');
    return this.mutations.mutate(churchId, id, (item) =>
      item.restoreVersion(record, this.clock.now()),
    );
  }
}

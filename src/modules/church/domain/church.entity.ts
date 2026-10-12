import { validationError } from '../../../shared/domain/domain-error.js';
import { slugify } from '../../../shared/domain/text.js';

export interface ChurchProps {
  id: string;
  userId: string;
  name: string;
  slug: string;
  ownerRole: string;
  logoObjectKey: string | null;
  denomination: string | null;
  website: string | null;
  description: string | null;
  preferredBibleTranslation: string;
  primaryColor: string | null;
  secondaryColor: string | null;
  devotionalTone: string | null;
  socialTone: string | null;
  audienceDescription: string;
  wordsToAvoid: string;
  additionalAIContext: string;
}

export type EditableChurchFields = Partial<
  Pick<
    ChurchProps,
    | 'name'
    | 'ownerRole'
    | 'denomination'
    | 'website'
    | 'description'
    | 'preferredBibleTranslation'
    | 'primaryColor'
    | 'secondaryColor'
    | 'devotionalTone'
    | 'socialTone'
    | 'audienceDescription'
    | 'wordsToAvoid'
    | 'additionalAIContext'
  >
>;

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const LIMITS: Record<string, number> = {
  name: 120,
  ownerRole: 80,
  denomination: 120,
  website: 255,
  description: 2000,
  preferredBibleTranslation: 20,
  devotionalTone: 200,
  socialTone: 200,
  audienceDescription: 1000,
  wordsToAvoid: 1000,
  additionalAIContext: 2000,
};

export class Church {
  private constructor(private props: ChurchProps) {}

  static create(input: {
    id: string;
    userId: string;
    name: string;
    ownerRole: string;
    denomination?: string | null;
    website?: string | null;
    slugSuffix?: string;
  }): Church {
    const church = new Church({
      id: input.id,
      userId: input.userId,
      name: '',
      slug: '',
      ownerRole: '',
      logoObjectKey: null,
      denomination: null,
      website: null,
      description: null,
      preferredBibleTranslation: 'NIV',
      primaryColor: null,
      secondaryColor: null,
      devotionalTone: null,
      socialTone: null,
      audienceDescription: '',
      wordsToAvoid: '',
      additionalAIContext: '',
    });
    church.update({
      name: input.name,
      ownerRole: input.ownerRole,
      denomination: input.denomination ?? null,
      website: input.website ?? null,
    });
    const base = slugify(church.props.name) || 'church';
    church.props.slug = input.slugSuffix ? `${base}-${input.slugSuffix}` : base;
    return church;
  }

  static restore(props: ChurchProps): Church {
    return new Church({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get logoObjectKey(): string | null {
    return this.props.logoObjectKey;
  }

  snapshot(): Readonly<ChurchProps> {
    return { ...this.props };
  }

  update(patch: EditableChurchFields): void {
    const next = { ...this.props };
    for (const [key, raw] of Object.entries(patch) as Array<
      [keyof EditableChurchFields, string | null | undefined]
    >) {
      if (raw === undefined) continue;
      const value = typeof raw === 'string' ? raw.trim() : raw;
      const limit = LIMITS[key];
      if (
        typeof value === 'string' &&
        limit !== undefined &&
        value.length > limit
      ) {
        throw validationError(key, `Must be at most ${limit} characters`);
      }
      (next as Record<string, unknown>)[key] = value;
    }
    if (!next.name) throw validationError('name', 'Church name is required');
    if (!next.ownerRole)
      throw validationError('ownerRole', 'Your role is required');
    if (!next.preferredBibleTranslation)
      throw validationError(
        'preferredBibleTranslation',
        'Bible translation is required',
      );
    for (const field of ['primaryColor', 'secondaryColor'] as const) {
      const color = next[field];
      if (color === '') next[field] = null;
      else if (color !== null && !HEX_COLOR.test(color))
        throw validationError(field, 'Use a #RRGGBB colour');
    }
    for (const field of [
      'denomination',
      'website',
      'description',
      'devotionalTone',
      'socialTone',
    ] as const) {
      if (next[field] === '') next[field] = null;
    }
    if (next.website !== null && !isHttpUrl(next.website))
      throw validationError('website', 'Enter a valid http(s) URL');
    this.props = next;
  }

  /** Returns the previous logo key so the caller can delete the replaced object. */
  replaceLogo(objectKey: string): string | null {
    const previous = this.props.logoObjectKey;
    this.props.logoObjectKey = objectKey;
    return previous;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Identity resolved from the session cookie. `churchId` is derived server-side, never from client input. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  churchId: string | null;
}

/** Church representation shared by the auth (`Me`) and church endpoints. */
export interface ChurchView {
  id: string;
  name: string;
  slug: string;
  ownerRole: string;
  denomination: string | null;
  website: string | null;
  description: string | null;
  logoUrl: string | null;
  preferredBibleTranslation: string;
  primaryColor: string | null;
  secondaryColor: string | null;
  devotionalTone: string | null;
  socialTone: string | null;
  audienceDescription: string;
  wordsToAvoid: string;
  additionalAIContext: string;
}

export const CHURCH_DIRECTORY = Symbol('CHURCH_DIRECTORY');

/** Read access to a user's church, implemented by the church module. */
export interface ChurchDirectoryPort {
  findViewByUserId(userId: string): Promise<ChurchView | null>;
  findIdByUserId(userId: string): Promise<string | null>;
}

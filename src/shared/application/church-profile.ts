/** Church preferences that shape AI prompts (tone, translation, audience). */
export interface ChurchAIProfile {
  churchId: string;
  name: string;
  preferredBibleTranslation: string;
  devotionalTone: string | null;
  socialTone: string | null;
  audienceDescription: string;
  wordsToAvoid: string;
  additionalAIContext: string;
}

export const CHURCH_PROFILE = Symbol('CHURCH_PROFILE');

export interface ChurchProfilePort {
  findAIProfile(churchId: string): Promise<ChurchAIProfile | null>;
}

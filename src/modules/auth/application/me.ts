import type { ChurchView } from '../../../shared/application/auth-context.js';
import type { User } from '../domain/user.entity.js';

export interface MeView {
  authenticated: boolean;
  user: { id: string; fullName: string; email: string } | null;
  onboardingCompleted: boolean;
  church: ChurchView | null;
}

export const SIGNED_OUT: MeView = {
  authenticated: false,
  user: null,
  onboardingCompleted: false,
  church: null,
};

export const toMeView = (user: User, church: ChurchView | null): MeView => ({
  authenticated: true,
  user: { id: user.id, fullName: user.fullName, email: user.email },
  onboardingCompleted: user.onboardingCompleted,
  church,
});

/** Result of a use case that starts a session; the HTTP adapter turns it into a cookie. */
export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

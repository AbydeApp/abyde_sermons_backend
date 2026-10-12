import { normalizeEmail } from './email.js';
import { assertPasswordPolicy } from './password-policy.js';
import { User } from './user.entity.js';

describe('auth domain', () => {
  it('normalises and validates emails', () => {
    expect(normalizeEmail('  Pastor@Church.ORG ')).toBe('pastor@church.org');
    expect(() => normalizeEmail('not-an-email')).toThrow();
  });

  it('enforces a password policy', () => {
    expect(() => assertPasswordPolicy('short1')).toThrow();
    expect(() => assertPasswordPolicy('lettersonly')).toThrow();
    expect(() => assertPasswordPolicy('x'.repeat(129) + '1')).toThrow();
    expect(() => assertPasswordPolicy('Faith2026')).not.toThrow();
  });

  it('tracks email changes and onboarding', () => {
    const user = User.register({
      id: 'u1',
      fullName: 'Ade',
      email: 'A@B.co',
      passwordHash: 'h',
      now: new Date(),
    });
    expect(user.changeEmail('a@b.co')).toBe(false);
    expect(user.changeEmail('new@b.co')).toBe(true);
    user.completeOnboarding();
    expect(user.snapshot()).toMatchObject({
      email: 'new@b.co',
      onboardingCompleted: true,
      emailVerifiedAt: null,
    });
  });
});

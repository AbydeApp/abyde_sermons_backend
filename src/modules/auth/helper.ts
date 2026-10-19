import { randomInt } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { ChurchView } from '../../shared/application/auth-context.js';
import type { EmailMessage } from '../../shared/application/ports/email.port.js';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { DomainError, validationError } from '../../shared/domain/domain-error.js';
import { slugify } from '../../shared/domain/text.js';
import type { ChurchRecord, UserRecord } from './auth.repository.js';

// ───────────────────────── Views ─────────────────────────

export interface MeView {
  authenticated: boolean;
  user: {
    id: string;
    fullName: string;
    email: string;
    phoneNumber: string | null;
  } | null;
  church: ChurchView | null;
}

/** What a client holds after signing in. `expiresIn` is the access token's lifetime in seconds. */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const SIGNED_OUT: MeView = {
  authenticated: false,
  user: null,
  church: null,
};

export const toMeView = (user: UserRecord, church: ChurchView | null): MeView => ({
  authenticated: true,
  user: {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phoneNumber: user.phoneNumber,
  },
  church,
});

// ───────────────────────── Limits ─────────────────────────

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;
export const NAME_MAX_LENGTH = 120;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Failed sign-ins allowed per email in one window. */
export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;
// Verified when the email is unknown so response time does not reveal which emails exist.
export const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;

export const PASSWORD_RESET_THROTTLE_SECONDS = 60;
export const CHURCH_ID_CACHE_SECONDS = 3600;
/** Kept for a while after expiry so recent sign-in history stays available for support. */
export const RETAIN_EXPIRED_MS = 30 * 24 * 3600 * 1000;
export const PURGE_EVERY_MS = 24 * 3600 * 1000;

// ───────────────────────── Cache keys & jobs ─────────────────────────

export const loginFailuresKey = (email: string) => `login-failures:${email}`;
export const passwordResetKey = (email: string) => `password-reset:${email}`;
export const otpSentKey = (userId: string) => `otp-sent:${userId}`;
export const sessionRevokedKey = (sessionId: string) => `session-revoked:${sessionId}`;
export const churchIdCacheKey = (userId: string) => `church-id:${userId}`;

export const PASSWORD_RESET_REQUEST_JOB = {
  queue: QUEUES.EMAIL,
  name: 'password-reset-request',
} as const;
export const PURGE_EXPIRED_AUTH_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'purge-expired-auth',
} as const;

// ───────────────────────── Normalisation & rules ─────────────────────────

export const trimLower = (raw: string): string => raw.trim().toLowerCase();

/** Emails are compared and stored normalized: trimmed and lower-cased. */
export function normalizeEmail(raw: string, field = 'email'): string {
  const email = trimLower(raw);
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw validationError(field, 'Enter a valid email address');
  }
  return email;
}

export function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > NAME_MAX_LENGTH)
    throw validationError('fullName', 'Full name is required');
  return name;
}

/** Optional; empty clears it. Digits, spaces and + ( ) . - only, 7 to 15 digits. */
export function normalizePhone(raw: string): string | null {
  const phone = raw.trim();
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!/^\+?[0-9\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15)
    throw validationError('phoneNumber', 'Enter a valid phone number');
  return phone;
}

export function assertPasswordPolicy(password: string, field = 'password'): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw validationError(
      field,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw validationError(
      field,
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw validationError(field, 'Password must contain letters and numbers');
  }
}

export const generateOtp = (): string =>
  String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

/** Hashed together with the user id so identical codes never share a hash. */
export const otpHashInput = (userId: string, code: string): string => `${userId}:${code}`;

export function readBearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

// ───────────────────────── Errors ─────────────────────────

export const emailTaken = () =>
  new DomainError(
    'CONFLICT',
    'EMAIL_TAKEN',
    'An account with this email already exists.',
    { email: ['An account with this email already exists'] },
  );

export const invalidCredentials = () =>
  new DomainError(
    'UNAUTHENTICATED',
    'INVALID_CREDENTIALS',
    'The email or password is incorrect.',
  );

export const unauthenticated = () =>
  new DomainError('UNAUTHENTICATED', 'UNAUTHENTICATED', 'Sign in to continue.');

export const invalidRefreshToken = () =>
  new DomainError(
    'UNAUTHENTICATED',
    'INVALID_REFRESH_TOKEN',
    'Your session has ended. Sign in again.',
  );

export const wrongPassword = () =>
  new DomainError(
    'UNPROCESSABLE',
    'WRONG_PASSWORD',
    'Your current password is incorrect.',
    { currentPassword: ['Your current password is incorrect'] },
  );

export const invalidResetToken = () =>
  new DomainError(
    'UNPROCESSABLE',
    'INVALID_RESET_TOKEN',
    'This reset link is invalid or has expired.',
    { token: ['This reset link is invalid or has expired'] },
  );

export const tooManySignInAttempts = () =>
  new DomainError(
    'RATE_LIMITED',
    'TOO_MANY_ATTEMPTS',
    'Too many sign-in attempts. Try again in a few minutes.',
  );

export const emailNotVerified = () =>
  new DomainError(
    'FORBIDDEN',
    'EMAIL_NOT_VERIFIED',
    "Verify your email to continue. We've sent you a new code.",
  );

export const otpInvalid = (message: string) =>
  new DomainError('UNPROCESSABLE', 'OTP_INVALID', message, { code: ['Invalid'] });
export const otpUnknown = () => otpInvalid("That code isn't valid. Request a new one.");
export const otpWrong = () =>
  otpInvalid("That code isn't right. Check your email and try again.");

export const otpExpired = () =>
  new DomainError(
    'UNPROCESSABLE',
    'OTP_EXPIRED',
    'That code has expired. Request a new one.',
    { code: ['Expired'] },
  );

export const otpLocked = () =>
  new DomainError(
    'RATE_LIMITED',
    'OTP_LOCKED',
    'Too many attempts. Request a new code.',
    { code: ['Locked'] },
  );

// ───────────────────────── Emails ─────────────────────────

export const verificationEmail = (user: UserRecord, code: string): EmailMessage => ({
  to: user.email,
  subject: 'Your Abyde Sermon verification code',
  text: `Hi ${user.fullName},\n\nYour verification code is ${code}. It expires in ${OTP_TTL_MS / 60_000} minutes.\n\nIf you didn't create an account, you can ignore this email.`,
});

export const passwordResetEmail = (
  user: UserRecord,
  link: string,
  ttlMinutes: number,
): EmailMessage => ({
  to: user.email,
  subject: 'Reset your Abyde Sermon password',
  text: `Hi ${user.fullName},\n\nUse the link below to choose a new password. It expires in ${ttlMinutes} minutes.\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
});

export const emailChangedNotice = (
  previousEmail: string,
  fullName: string,
): EmailMessage => ({
  to: previousEmail,
  subject: 'Your Abyde Sermon email address was changed',
  text: `Hi ${fullName},\n\nThe email address on your Abyde Sermon account was just changed to a new address. If this was you, no action is needed.\n\nIf it wasn't you, reset your password straight away and contact support.`,
});

export const passwordResetLink = (webUrl: string, token: string): string =>
  `${webUrl}/reset-password?token=${encodeURIComponent(token)}`;

// ───────────────────────── Request schemas ─────────────────────────

const email = z
  .string({ error: 'Email is required' })
  .min(1, 'Email is required')
  .max(EMAIL_MAX_LENGTH);
const password = z
  .string({ error: 'Password is required' })
  .min(1, 'Password is required')
  .max(256);
const refreshToken = z
  .string({ error: 'Refresh token is required' })
  .min(1, 'Refresh token is required')
  .max(200);

export const RegisterBody = z.object({
  fullName: z.string({ error: 'Full name is required' }).max(NAME_MAX_LENGTH),
  email,
  password,
  churchName: z.string().max(120).optional(),
});
export const VerifyEmailBody = z.object({
  email,
  code: z.string().min(1, 'Code is required').max(20),
});
export const ResendBody = z.object({ email });
export const LoginBody = z.object({
  email,
  password,
  remember: z.boolean().default(false),
});
export const RefreshBody = z.object({ refreshToken });
export const LogoutBody = z.object({ refreshToken: refreshToken.optional() });
export const UpdateMeBody = z.object({
  fullName: z.string().max(NAME_MAX_LENGTH).optional(),
  email: email.optional(),
  phoneNumber: z.string().max(40).optional(),
});
export const ChangePasswordBody = z.object({
  currentPassword: password,
  newPassword: password,
});
export const ForgotBody = z.object({ email });
export const ResetBody = z.object({
  token: z.string().min(1, 'Token is required').max(200),
  password,
});

// ───────────────────────── Church: defaults & limits ─────────────────────────

/** Signup asks only for a name; the owner role is refined later in Settings. */
export const DEFAULT_CHURCH_NAME = 'Your Ministry';
export const DEFAULT_OWNER_ROLE = 'Owner';
export const DEFAULT_BIBLE_TRANSLATION = 'NIV';
export const SLUG_SUFFIX_LENGTH = 6;
export const FALLBACK_SLUG = 'church';
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

export type EditableChurchFields = Partial<
  Pick<
    ChurchRecord,
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

// ───────────────────────── Church: errors ─────────────────────────

export const churchExists = () =>
  new DomainError('CONFLICT', 'CHURCH_EXISTS', 'You already have a church.');

// ───────────────────────── Church: rules ─────────────────────────

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Returns a validated copy of `church` with `patch` applied; throws a field error otherwise. */
export function applyChurchPatch(
  church: ChurchRecord,
  patch: EditableChurchFields,
): ChurchRecord {
  const next = { ...church };
  for (const [key, raw] of Object.entries(patch) as Array<
    [keyof EditableChurchFields, string | null | undefined]
  >) {
    if (raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    const limit = LIMITS[key];
    if (typeof value === 'string' && limit !== undefined && value.length > limit) {
      throw validationError(key, `Must be at most ${limit} characters`);
    }
    (next as Record<string, unknown>)[key] = value;
  }
  if (!next.name) throw validationError('name', 'Church name is required');
  if (!next.ownerRole) throw validationError('ownerRole', 'Your role is required');
  if (!next.preferredBibleTranslation)
    throw validationError('preferredBibleTranslation', 'Bible translation is required');
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
  return next;
}

export function newChurchRecord(input: {
  createdAt: Date;
  id: string;
  userId: string;
  name: string;
  ownerRole: string;
  slugSuffix?: string;
}): ChurchRecord {
  const church = applyChurchPatch(
    {
      id: input.id,
      createdAt: input.createdAt,
      userId: input.userId,
      name: '',
      slug: '',
      ownerRole: '',
      denomination: null,
      website: null,
      description: null,
      preferredBibleTranslation: DEFAULT_BIBLE_TRANSLATION,
      primaryColor: null,
      secondaryColor: null,
      devotionalTone: null,
      socialTone: null,
      audienceDescription: '',
      wordsToAvoid: '',
      additionalAIContext: '',
    },
    { name: input.name, ownerRole: input.ownerRole },
  );
  const base = slugify(church.name) || FALLBACK_SLUG;
  church.slug = input.slugSuffix ? `${base}-${input.slugSuffix}` : base;
  return church;
}

export function toChurchView(church: ChurchRecord): ChurchView {
  const { userId: _userId, createdAt: _createdAt, ...view } = church;
  return view;
}

// ───────────────────────── Church: request schemas ─────────────────────────

const text = (max: number) => z.string().max(max, `Must be at most ${max} characters`);
const nullableText = (max: number) => text(max).nullable();

export const UpdateChurchBody = z
  .object({
    name: text(120),
    ownerRole: text(80),
    denomination: nullableText(120),
    website: nullableText(255),
    description: nullableText(2000),
    preferredBibleTranslation: text(20),
    primaryColor: nullableText(7),
    secondaryColor: nullableText(7),
    devotionalTone: nullableText(200),
    socialTone: nullableText(200),
    audienceDescription: text(1000),
    wordsToAvoid: text(1000),
    additionalAIContext: text(2000),
  })
  .partial()
  .strict();

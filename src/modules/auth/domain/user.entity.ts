import { validationError } from '../../../shared/domain/domain-error.js';
import { normalizeEmail } from './email.js';

export interface UserProps {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  onboardingCompleted: boolean;
  createdAt: Date;
}

export class User {
  private constructor(private props: UserProps) {}

  static register(input: {
    id: string;
    fullName: string;
    email: string;
    passwordHash: string;
    now: Date;
  }): User {
    return new User({
      id: input.id,
      fullName: User.validName(input.fullName),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      emailVerifiedAt: null,
      onboardingCompleted: false,
      createdAt: input.now,
    });
  }

  static restore(props: UserProps): User {
    return new User({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get fullName(): string {
    return this.props.fullName;
  }
  get email(): string {
    return this.props.email;
  }
  get passwordHash(): string {
    return this.props.passwordHash;
  }
  get onboardingCompleted(): boolean {
    return this.props.onboardingCompleted;
  }

  snapshot(): Readonly<UserProps> {
    return { ...this.props };
  }

  rename(fullName: string): void {
    this.props.fullName = User.validName(fullName);
  }

  changeEmail(email: string): boolean {
    const normalized = normalizeEmail(email);
    if (normalized === this.props.email) return false;
    this.props.email = normalized;
    this.props.emailVerifiedAt = null;
    return true;
  }

  changePasswordHash(passwordHash: string): void {
    this.props.passwordHash = passwordHash;
  }

  completeOnboarding(): void {
    this.props.onboardingCompleted = true;
  }

  private static validName(fullName: string): string {
    const name = fullName.trim();
    if (name.length < 1 || name.length > 120)
      throw validationError('fullName', 'Full name is required');
    return name;
  }
}

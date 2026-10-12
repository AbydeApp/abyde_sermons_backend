import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../../../../shared/domain/domain-error.js';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/out/user-repository.port.js';

/** Called by the church module when the user's church is created (onboarding = church exists). */
@Injectable()
export class CompleteOnboardingUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw notFound('User');
    if (user.onboardingCompleted) return;
    user.completeOnboarding();
    await this.users.save(user);
  }
}

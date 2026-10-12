import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  defineJobHandler,
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../../../shared/application/jobs.js';
import { QUEUES } from '../../../../shared/application/ports/queue.port.js';
import {
  ForgotPasswordUseCase,
  PASSWORD_RESET_REQUEST_JOB,
} from '../../application/use-cases/password-reset.use-cases.js';
import { PurgeExpiredAuthUseCase } from '../../application/use-cases/purge-expired-auth.use-case.js';

const PURGE_EXPIRED_AUTH_JOB = {
  queue: QUEUES.MAINTENANCE,
  name: 'purge-expired-auth',
} as const;

@Injectable()
export class AuthJobHandlers implements OnModuleInit {
  constructor(
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
    @Inject(PurgeExpiredAuthUseCase)
    private readonly purge: PurgeExpiredAuthUseCase,
    @Inject(ForgotPasswordUseCase)
    private readonly forgotPassword: ForgotPasswordUseCase,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<{ email: string }>(
        PASSWORD_RESET_REQUEST_JOB,
        (payload) => this.forgotPassword.process(payload.email),
      ),
    );
    this.registry.register(
      defineJobHandler(
        PURGE_EXPIRED_AUTH_JOB,
        async () => void (await this.purge.execute()),
      ),
    );
    this.registry.registerRecurring({
      queue: PURGE_EXPIRED_AUTH_JOB.queue,
      jobName: PURGE_EXPIRED_AUTH_JOB.name,
      everyMs: 24 * 3600 * 1000,
    });
  }
}

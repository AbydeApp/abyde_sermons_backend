import { Inject, Injectable } from '@nestjs/common';
import type { EmailMessage, EmailSenderPort } from '../../application/ports/email.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import { DependencyGuard } from '../resilience/dependency-guard.js';
import type { AppConfig } from '../config/env.schema.js';

@Injectable()
export class ResendEmailAdapter implements EmailSenderPort {
  private readonly guard = new DependencyGuard('resend', {
    maxConcurrent: 8,
    failureThreshold: 5,
    openMs: 30_000,
  });

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await this.guard.run(() =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.EMAIL_RESEND_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.EMAIL_FROM,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(15_000),
      }).then((res) => {
        if (res.status >= 500 || res.status === 429)
          throw new Error(`Resend responded ${res.status}`);
        return res;
      }),
    );
    if (!response.ok) throw new Error(`Resend responded ${response.status}`);
  }
}

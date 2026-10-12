import { Inject, Injectable } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../../domain/id.js';
import type {
  EmailMessage,
  EmailSenderPort,
} from '../../application/ports/email.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';

/**
 * Development adapter: writes emails to a local outbox directory instead of sending them,
 * so reset links can be used locally without ever appearing in logs.
 */
@Injectable()
export class OutboxEmailAdapter implements EmailSenderPort {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(message: EmailMessage): Promise<void> {
    await mkdir(this.config.EMAIL_OUTBOX_DIR, { recursive: true });
    const file = join(
      this.config.EMAIL_OUTBOX_DIR,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${newId()}.txt`,
    );
    await writeFile(
      file,
      `To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`,
      { mode: 0o600 },
    );
  }
}

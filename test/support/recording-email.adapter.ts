import type {
  EmailMessage,
  EmailSenderPort,
} from '../../src/shared/application/ports/email.port.js';

/** Test double that records messages in memory. */
export class RecordingEmailAdapter implements EmailSenderPort {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

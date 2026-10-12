import { Inject, Injectable } from '@nestjs/common';
import type { ChurchView } from '../../../shared/application/auth-context.js';
import {
  STORAGE,
  type StoragePort,
} from '../../../shared/application/ports/storage.port.js';
import type { Church } from '../domain/church.entity.js';

const LOGO_URL_TTL_SECONDS = 3600;

@Injectable()
export class ChurchPresenter {
  constructor(@Inject(STORAGE) private readonly storage: StoragePort) {}

  async present(church: Church): Promise<ChurchView> {
    const { userId: _userId, logoObjectKey, ...props } = church.snapshot();
    return {
      ...props,
      // Private bucket: the logo is exposed only through a short-lived signed URL.
      logoUrl: logoObjectKey
        ? await this.storage.createDownloadUrl(
            logoObjectKey,
            LOGO_URL_TTL_SECONDS,
          )
        : null,
    };
  }
}

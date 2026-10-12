import { Inject, Injectable } from '@nestjs/common';
import { BrandProfileService } from '../../brand/application/use-cases/brand-profile.use-cases.js';
import type {
  ReelBrand,
  ReelBrandPort,
} from '../application/ports/out/reel.ports.js';

/** Adapter onto Brand Studio: the church's look, voice and Reel defaults. */
@Injectable()
export class ReelBrandAdapter implements ReelBrandPort {
  constructor(
    @Inject(BrandProfileService) private readonly brand: BrandProfileService,
  ) {}

  async load(churchId: string): Promise<ReelBrand> {
    const profile = await this.brand.load(churchId);
    return {
      snapshot: await this.brand.reelSnapshot(profile),
      videoSettings: profile.videoSettings,
      voice: profile.voice,
    };
  }
}

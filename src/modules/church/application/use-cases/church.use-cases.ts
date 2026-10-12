import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthContext, ChurchDirectoryPort, ChurchView } from '../../../../shared/application/auth-context.js';
import type { ChurchAIProfile, ChurchProfilePort } from '../../../../shared/application/church-profile.js';
import { STORAGE, type PresignedUpload, type StoragePort } from '../../../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../../../shared/application/ports/unit-of-work.port.js';
import { DomainError, notFound } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import { CompleteOnboardingUseCase } from '../../../auth/application/use-cases/complete-onboarding.use-case.js';
import { GetMeUseCase } from '../../../auth/application/use-cases/account.use-cases.js';
import type { MeView } from '../../../auth/application/me.js';
import { ConsumeUploadUseCase, PresignUploadUseCase } from '../../../uploads/application/use-cases/upload.use-cases.js';
import { Church, type EditableChurchFields } from '../../domain/church.entity.js';
import { ChurchPresenter } from '../church-presenter.js';
import { CHURCH_REPOSITORY, type ChurchRepositoryPort } from '../ports/out/church-repository.port.js';

export const churchExists = () =>
  new DomainError(
    'CONFLICT',
    'CHURCH_EXISTS',
    'You have already created your church.',
  );

@Injectable()
export class CreateChurchUseCase {
  constructor(
    @Inject(CHURCH_REPOSITORY) private readonly churches: ChurchRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CompleteOnboardingUseCase)
    private readonly completeOnboarding: CompleteOnboardingUseCase,
    @Inject(GetMeUseCase) private readonly getMe: GetMeUseCase,
  ) {}

  async execute(
    auth: AuthContext,
    input: {
      name: string;
      ownerRole: string;
      denomination?: string | null;
    },
  ): Promise<MeView> {
    // Serialise per user so a double-submit cannot create two churches (the unique index is the backstop).
    const church = await this.uow.runLocked(
      `church:create:${auth.userId}`,
      async () => {
        if (await this.churches.findIdByUserId(auth.userId))
          throw churchExists();
        let candidate = Church.create({
          id: newId(),
          userId: auth.userId,
          ...input,
        });
        if (await this.churches.slugExists(candidate.snapshot().slug)) {
          candidate = Church.create({
            id: candidate.id,
            userId: auth.userId,
            ...input,
            slugSuffix: newId().slice(0, 6),
          });
        }
        await this.churches.save(candidate);
        await this.completeOnboarding.execute(auth.userId);
        return candidate;
      },
    );
    return this.getMe.execute({ ...auth, churchId: church.id });
  }
}

@Injectable()
export class GetChurchUseCase {
  constructor(
    @Inject(CHURCH_REPOSITORY) private readonly churches: ChurchRepositoryPort,
    @Inject(ChurchPresenter) private readonly presenter: ChurchPresenter,
  ) {}

  async execute(churchId: string): Promise<ChurchView> {
    const church = await this.churches.findById(churchId);
    if (!church) throw notFound('Church');
    return this.presenter.present(church);
  }
}

@Injectable()
export class UpdateChurchUseCase {
  private readonly logger = new Logger(UpdateChurchUseCase.name);

  constructor(
    @Inject(CHURCH_REPOSITORY) private readonly churches: ChurchRepositoryPort,
    @Inject(ConsumeUploadUseCase)
    private readonly consumeUpload: ConsumeUploadUseCase,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(ChurchPresenter) private readonly presenter: ChurchPresenter,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}


  async execute(
    churchId: string,
    patch: EditableChurchFields & { logoObjectKey?: string },
  ): Promise<ChurchView> {
    const church = await this.churches.findById(churchId);
    if (!church) throw notFound('Church');
    const { logoObjectKey, ...fields } = patch;
    church.update(fields);
    let replacedLogo: string | null = null;
    if (logoObjectKey !== undefined && logoObjectKey !== church.logoObjectKey) {
      const upload = await this.consumeUpload.verify({
        churchId,
        objectKey: logoObjectKey,
        purpose: 'CHURCH_LOGO',
      });
      replacedLogo = church.replaceLogo(logoObjectKey);
      // Claiming the upload and saving the church succeed or fail together, so a failed save
      // never burns the upload.
      await this.uow.run(async () => {
        await this.consumeUpload.claim(upload);
        await this.churches.save(church);
      });
    } else {
      await this.churches.save(church);
    }
    if (replacedLogo) {
      await this.storage
        .deleteObject(replacedLogo)
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, 'Failed to delete replaced logo'),
        );
    }
    return this.presenter.present(church);
  }
}

@Injectable()
export class PresignLogoUseCase {
  constructor(
    @Inject(PresignUploadUseCase)
    private readonly presign: PresignUploadUseCase,
  ) {}

  execute(
    churchId: string,
    input: { fileName: string; contentType: string; sizeBytes: number },
  ): Promise<PresignedUpload> {
    return this.presign.execute({ churchId, purpose: 'CHURCH_LOGO', ...input });
  }
}

/** Implements the shared ChurchDirectoryPort consumed by the auth module. */
@Injectable()
export class ChurchDirectory implements ChurchDirectoryPort {
  constructor(
    @Inject(CHURCH_REPOSITORY) private readonly churches: ChurchRepositoryPort,
    @Inject(ChurchPresenter) private readonly presenter: ChurchPresenter,
  ) {}

  async findViewByUserId(userId: string): Promise<ChurchView | null> {
    const church = await this.churches.findByUserId(userId);
    return church ? this.presenter.present(church) : null;
  }

  findIdByUserId(userId: string): Promise<string | null> {
    return this.churches.findIdByUserId(userId);
  }
}

/** Implements CHURCH_PROFILE: preferences used to shape AI prompts. */
@Injectable()
export class ChurchProfileService implements ChurchProfilePort {
  constructor(
    @Inject(CHURCH_REPOSITORY) private readonly churches: ChurchRepositoryPort,
  ) {}

  async findAIProfile(churchId: string): Promise<ChurchAIProfile | null> {
    const church = await this.churches.findById(churchId);
    if (!church) return null;
    const props = church.snapshot();
    return {
      churchId: props.id,
      name: props.name,
      preferredBibleTranslation: props.preferredBibleTranslation,
      devotionalTone: props.devotionalTone,
      socialTone: props.socialTone,
      audienceDescription: props.audienceDescription,
      wordsToAvoid: props.wordsToAvoid,
      additionalAIContext: props.additionalAIContext,
    };
  }
}

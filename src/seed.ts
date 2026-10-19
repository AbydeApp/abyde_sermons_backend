import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
} from './modules/auth/auth.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import { CreateSermonUseCase } from './modules/sermons/application/use-cases/sermon-crud.use-cases.js';
import { APP_CONFIG } from './shared/infrastructure/config/config.module.js';
import type { AppConfig } from './shared/infrastructure/config/env.schema.js';

/**
 * Development seed: two fictional churches with demo sermons, created through the real use cases
 * (so every invariant applies) and processed by the worker. Idempotent: existing demo users are skipped.
 * Refuses to run in staging/production.
 */
const DEMO = [
  {
    user: { fullName: 'Demo Pastor Grace', email: 'grace.demo@example.com' },
    church: {
      name: 'Grace Demo Church',
      ownerRole: 'Lead Pastor',
      denomination: 'Non-denominational',
    },
    sermons: [
      {
        title: 'Walking By Faith',
        speaker: 'Pastor Demo',
        sermonDate: new Date('2026-09-27T09:00:00Z'),
        series: 'Trust',
        mainScripture: '2 Corinthians 5:7',
        tags: ['faith', 'trust'],
        transcriptText:
          'Good morning church. Please open your Bibles to 2 Corinthians 5:7. For we live by faith, not by sight. ' +
          'Faith is not the absence of questions; it is trusting God in the middle of them. ' +
          'Hebrews 11:1 tells us that faith is confidence in what we hope for and assurance about what we do not see. ' +
          'When our family moved with no plan, God did not show us the whole road, but He gave us enough light for the next step. ' +
          'This week, take one step of obedience you have been putting off. Trust is built one step at a time. '.repeat(
            3,
          ),
      },
    ],
  },
  {
    user: { fullName: 'Demo Pastor Hope', email: 'hope.demo@example.com' },
    church: {
      name: 'Hope Demo Fellowship',
      ownerRole: 'Senior Pastor',
      denomination: 'Pentecostal',
    },
    sermons: [
      {
        title: 'Peace In The Storm',
        speaker: 'Pastor Demo Two',
        sermonDate: new Date('2026-09-20T09:00:00Z'),
        series: 'Peace',
        mainScripture: 'Mark 4:39',
        tags: ['peace'],
        transcriptText:
          'Turn with me to Mark 4:39. Jesus got up, rebuked the wind and said to the waves, Quiet! Be still! ' +
          'Storms reveal what we really trust. Philippians 4:7 promises a peace that transcends all understanding. ' +
          'Peace is not the absence of storms but the presence of Jesus in the boat with us. '.repeat(
            4,
          ),
      },
    ],
  },
];

async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule.register(), {
    logger: ['error', 'warn'],
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  if (config.APP_ENV === 'production' || config.APP_ENV === 'staging') {
    await app.close();
    throw new Error('Refusing to seed a staging/production environment');
  }
  try {
    const users = app.get<AuthRepository>(AUTH_REPOSITORY);
    for (const demo of DEMO) {
      if (await users.findUserByEmail(demo.user.email)) {
        console.log(`skip ${demo.user.email} (already seeded)`);
        continue;
      }
      await app.get(AuthService).register({
        ...demo.user,
        password: 'DemoPass2026',
        churchName: demo.church.name,
      });
      // No inbox in development: confirm the address directly.
      const created = await users.findUserByEmail(demo.user.email);
      if (!created) throw new Error(`Could not create ${demo.user.email}`);
      await users.saveUser({ ...created, emailVerifiedAt: new Date() });
      const auth = app.get(AuthService);
      const churchId = (await auth.findIdByUserId(created.id)) ?? '';
      await auth.updateChurch(churchId, {
        ownerRole: demo.church.ownerRole,
        denomination: demo.church.denomination,
      });
      for (const sermon of demo.sermons)
        await app.get(CreateSermonUseCase).execute(churchId, sermon);
      console.log(
        `seeded ${demo.user.email} / ${demo.church.name} (password: DemoPass2026)`,
      );
    }
    console.log(
      'Done. Start the worker (npm run start:worker) to process the demo sermons.',
    );
  } finally {
    await app.close();
  }
}

await seed();

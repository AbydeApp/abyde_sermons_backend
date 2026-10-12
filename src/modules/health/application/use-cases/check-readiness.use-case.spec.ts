import type { ReadinessCheckPort } from '../ports/out/readiness-check.port.js';
import { CheckReadinessUseCase } from './check-readiness.use-case.js';

const fake = (
  name: string,
  check: () => Promise<void>,
): ReadinessCheckPort => ({ name, check });

describe('CheckReadinessUseCase', () => {
  it('is ready when every dependency is up', async () => {
    const useCase = new CheckReadinessUseCase([
      fake('database', async () => undefined),
      fake('redis', async () => undefined),
    ]);
    await expect(useCase.execute()).resolves.toEqual({
      ready: true,
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('is not ready when any dependency fails', async () => {
    const useCase = new CheckReadinessUseCase([
      fake('database', async () => undefined),
      fake('redis', () => Promise.reject(new Error('down'))),
    ]);
    await expect(useCase.execute()).resolves.toEqual({
      ready: false,
      checks: { database: 'up', redis: 'down' },
    });
  });
});

import {
  DependencyGuard,
  DependencyUnavailableError,
} from './dependency-guard.js';

describe('DependencyGuard', () => {
  const failing = () => Promise.reject(new Error('provider down'));

  it('opens after consecutive failures, fails fast, then lets one trial through', async () => {
    let now = 0;
    const guard = new DependencyGuard('provider', {
      maxConcurrent: 5,
      failureThreshold: 3,
      openMs: 10_000,
      now: () => now,
    });
    for (let i = 0; i < 3; i++)
      await expect(guard.run(failing)).rejects.toThrow('provider down');
    expect(guard.state).toBe('open');
    const call = vi.fn(async () => 'ok');
    await expect(guard.run(call)).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    expect(call).not.toHaveBeenCalled();

    now = 10_001;
    expect(guard.state).toBe('half-open');
    await expect(guard.run(failing)).rejects.toThrow('provider down'); // trial fails → open again
    expect(guard.state).toBe('open');
    now = 20_002;
    await expect(guard.run(call)).resolves.toBe('ok'); // trial succeeds → closed
    expect(guard.state).toBe('closed');
  });

  it('a success resets the failure count; ignored errors do not count', async () => {
    const guard = new DependencyGuard('provider', {
      maxConcurrent: 5,
      failureThreshold: 2,
      openMs: 1000,
      isFailure: (e) => (e as Error).message !== 'bad request',
    });
    await expect(guard.run(failing)).rejects.toThrow();
    await guard.run(async () => 'ok');
    await expect(guard.run(failing)).rejects.toThrow();
    expect(guard.state).toBe('closed');
    for (let i = 0; i < 5; i++)
      await expect(
        guard.run(() => Promise.reject(new Error('bad request'))),
      ).rejects.toThrow('bad request');
    expect(guard.state).toBe('closed');
  });

  it('caps concurrent calls and frees the slot afterwards', async () => {
    const guard = new DependencyGuard('provider', {
      maxConcurrent: 2,
      failureThreshold: 3,
      openMs: 1000,
    });
    const releases: Array<() => void> = [];
    const slow = () => new Promise<void>((resolve) => releases.push(resolve));
    const first = guard.run(slow);
    const second = guard.run(slow);
    await expect(guard.run(async () => 'x')).rejects.toMatchObject({
      reason: 'at-capacity',
    });
    for (const release of releases) release();
    await Promise.all([first, second]);
    await expect(guard.run(async () => 'x')).resolves.toBe('x');
  });
});

/** Raised without calling the dependency: its circuit is open or its concurrency cap is reached. */
export class DependencyUnavailableError extends Error {
  constructor(
    readonly dependency: string,
    readonly reason: 'circuit-open' | 'at-capacity',
    readonly retryAfterSeconds: number,
  ) {
    super(`${dependency} is unavailable (${reason})`);
    this.name = 'DependencyUnavailableError';
  }
}

export interface DependencyGuardOptions {
  /** Calls allowed in flight at once in this process (bulkhead). Extra calls fail fast. */
  maxConcurrent: number;
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial call is let through. */
  openMs: number;
  /** Which errors count against the dependency (default: all). Client mistakes (4xx) should not. */
  isFailure?: (error: unknown) => boolean;
  now?: () => number;
}

/**
 * Circuit breaker + concurrency cap for one external dependency. Lives in adapters, behind the
 * port, so a slow or failing provider cannot tie up every request or worker slot in the process:
 * after repeated failures calls fail immediately until the provider has had time to recover.
 * State is per process by design (each replica protects itself).
 */
export class DependencyGuard {
  private active = 0;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    private readonly options: DependencyGuardOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.consecutiveFailures < this.options.failureThreshold)
      return 'closed';
    return this.now() < this.openUntil ? 'open' : 'half-open';
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open') {
      throw new DependencyUnavailableError(
        this.name,
        'circuit-open',
        Math.ceil((this.openUntil - this.now()) / 1000),
      );
    }
    // Half-open: exactly one trial call decides whether the circuit closes again.
    if (state === 'half-open' && this.trialInFlight) {
      throw new DependencyUnavailableError(this.name, 'circuit-open', 1);
    }
    if (this.active >= this.options.maxConcurrent) {
      throw new DependencyUnavailableError(this.name, 'at-capacity', 1);
    }
    const isTrial = state === 'half-open';
    if (isTrial) this.trialInFlight = true;
    this.active++;
    try {
      const result = await call();
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      if (this.options.isFailure?.(error) ?? true) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.options.failureThreshold) {
          this.openUntil = this.now() + this.options.openMs;
        }
      }
      throw error;
    } finally {
      this.active--;
      if (isTrial) this.trialInFlight = false;
    }
  }
}

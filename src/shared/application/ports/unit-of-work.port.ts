export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/**
 * Runs a callback atomically. Repositories invoked inside `fn` join the same transaction.
 * `runLocked` additionally serialises concurrent callers on `lockKey` (transaction-scoped lock),
 * which is how use cases guard read-check-write races such as plan limits or generation groups.
 */
export interface UnitOfWorkPort {
  run<T>(fn: () => Promise<T>): Promise<T>;
  runLocked<T>(lockKey: string, fn: () => Promise<T>): Promise<T>;
}

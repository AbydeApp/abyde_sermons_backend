import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Carries provider token counts from an adapter back to the metering decorator without
 * widening the provider-agnostic port. Each metered call opens its own scope.
 */
interface TokenUsageScope {
  inputTokens: number;
  outputTokens: number;
}

const storage = new AsyncLocalStorage<TokenUsageScope>();

export function withTokenUsageScope<T>(fn: () => Promise<T>): {
  scope: TokenUsageScope;
  result: Promise<T>;
} {
  const scope: TokenUsageScope = { inputTokens: 0, outputTokens: 0 };
  return { scope, result: storage.run(scope, fn) };
}

export function reportTokenUsage(
  inputTokens: number,
  outputTokens: number,
): void {
  const scope = storage.getStore();
  if (scope) {
    scope.inputTokens += inputTokens;
    scope.outputTokens += outputTokens;
  }
}

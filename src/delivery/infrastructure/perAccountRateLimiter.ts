export type PerAccountRateLimiter = {
  readonly waitForTurn: (accountId: string) => Promise<void>;
};

type RateLimiterDependencies = {
  readonly nowMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: RateLimiterDependencies = {
  nowMs: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

export const buildPerAccountRateLimiter = (
  ratePerMinute: number,
  dependencies: RateLimiterDependencies = defaultDependencies,
): PerAccountRateLimiter => {
  const intervalMs = Math.ceil(60_000 / ratePerMinute);
  const nextAllowedByAccount = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();

  return {
    waitForTurn: async (accountId) => {
      const prior = tails.get(accountId) ?? Promise.resolve();
      const turn = prior.then(async () => {
        const waitMs = Math.max(
          0,
          (nextAllowedByAccount.get(accountId) ?? dependencies.nowMs()) - dependencies.nowMs(),
        );
        if (waitMs > 0) await dependencies.sleep(waitMs);
        nextAllowedByAccount.set(accountId, dependencies.nowMs() + intervalMs);
      });
      tails.set(accountId, turn);
      await turn;
      if (tails.get(accountId) === turn) tails.delete(accountId);
    },
  };
};

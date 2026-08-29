import { describe, expect, it, vi } from "vitest";
import { buildPerAccountRateLimiter } from "../../src/delivery/infrastructure/perAccountRateLimiter.js";

describe("delivery/infrastructure/perAccountRateLimiter", () => {
  /* REQ-DELIVERY-038: Each account is throttled independently at the configured rate. */
  it("delays consecutive turns for one account", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const limiter = buildPerAccountRateLimiter(10, { nowMs: () => now, sleep });

    await limiter.waitForTurn("work");
    await limiter.waitForTurn("work");
    await limiter.waitForTurn("personal");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(6_000);
  });
});

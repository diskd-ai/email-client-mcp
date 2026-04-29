import { describe, expect, it } from "vitest";
import {
  clampTickInterval,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MIN_TICK_INTERVAL_MS,
  nextBackoff,
} from "../../src/sync/backoff.js";

describe("sync/backoff", () => {
  /* REQUIREMENT end:comm/email-client-mcp/sync/backoff -- first retry uses INITIAL_BACKOFF_MS */
  it("starts at INITIAL_BACKOFF_MS", () => {
    expect(nextBackoff(null)).toBe(INITIAL_BACKOFF_MS);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync/backoff -- doubles each step up to a cap */
  it("doubles up to MAX_BACKOFF_MS", () => {
    let prev: number | null = null;
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const v = nextBackoff(prev);
      expect(v).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      prev = v;
      last = v;
    }
    expect(last).toBe(MAX_BACKOFF_MS);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync/watcher -- intervals below the floor are clamped to 60s */
  it("clamps tick intervals to the >=60s floor", () => {
    expect(clampTickInterval(0)).toBe(MIN_TICK_INTERVAL_MS);
    expect(clampTickInterval(30_000)).toBe(MIN_TICK_INTERVAL_MS);
    expect(clampTickInterval(60_000)).toBe(60_000);
    expect(clampTickInterval(120_000)).toBe(120_000);
  });
});

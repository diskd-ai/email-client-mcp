import { describe, expect, it, vi } from "vitest";
import type { OutboxRepository } from "../../src/delivery/application/outboxRepository.js";
import { buildDeliveryRuntime } from "../../src/delivery/infrastructure/deliveryRuntime.js";
import { None, Ok } from "../../src/domain/result.js";

describe("delivery/infrastructure/deliveryRuntime", () => {
  /* REQ-DELIVERY-043: Delivery starts from the Drive Outbox without requiring NATS access in the MCP namespace. */
  it("reconciles pending Drive items immediately", async () => {
    const listPending = vi.fn(async () => Ok({ items: [], nextCursor: None }));
    const unavailable = async (): Promise<never> => {
      throw new Error("not used by this test");
    };
    const repository: OutboxRepository = {
      get: unavailable,
      listPending,
      claim: unavailable,
      renewLease: unavailable,
      writeProgress: unavailable,
      writeTerminal: unavailable,
    };
    const log = vi.fn();
    const runtime = buildDeliveryRuntime({
      repository,
      processor: { process: vi.fn() },
      log,
    });

    await runtime.start();
    await runtime.stop();

    expect(listPending).toHaveBeenCalledWith({ limit: 100, cursor: None });
    expect(log).toHaveBeenCalledWith("delivery.ready", {
      source: "drive-outbox-reconciliation",
      intervalMs: 60_000,
    });
  });
});

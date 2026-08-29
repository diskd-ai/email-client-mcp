import { None, type Option, Some } from "../../domain/result.js";
import type { OutboxRepository } from "../application/outboxRepository.js";
import type { DeliveryLog, DeliveryProcessor } from "./deliveryProcessor.js";

const RECONCILIATION_INTERVAL_MS = 60_000;
const RECONCILIATION_PAGE_SIZE = 100;

export type DeliveryRuntime = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

type DeliveryRuntimeDependencies = {
  readonly repository: OutboxRepository;
  readonly processor: DeliveryProcessor;
  readonly log: DeliveryLog;
};

const reconcilePending = async (dependencies: DeliveryRuntimeDependencies): Promise<void> => {
  let cursor: Option<string> = None;
  const seenCursors = new Set<string>();
  for (;;) {
    const page = await dependencies.repository.listPending({
      limit: RECONCILIATION_PAGE_SIZE,
      cursor,
    });
    if (page.tag === "Err") {
      dependencies.log("delivery.reconciliation-list-failed", {
        error: page.error.kind,
        operation: page.error.operation,
      });
      return;
    }
    for (const item of page.value.items) {
      const disposition = await dependencies.processor.process({
        kind: "Reconciliation",
        externalId: item.externalId,
      });
      dependencies.log("delivery.reconciliation-item", {
        externalId: item.externalId,
        disposition: disposition.kind,
      });
    }
    if (page.value.nextCursor.tag === "None") return;
    if (seenCursors.has(page.value.nextCursor.value)) {
      dependencies.log("delivery.reconciliation-cursor-cycle", {
        cursor: page.value.nextCursor.value,
      });
      return;
    }
    seenCursors.add(page.value.nextCursor.value);
    cursor = Some(page.value.nextCursor.value);
  }
};

export const buildDeliveryRuntime = (
  dependencies: DeliveryRuntimeDependencies,
): DeliveryRuntime => {
  let reconciliation: Promise<void> | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined;
  let stopping = false;

  const beginReconciliation = (): void => {
    if (stopping) return;
    if (reconciliation !== undefined) {
      dependencies.log("delivery.reconciliation-skipped", { reason: "previous sweep is active" });
      return;
    }
    reconciliation = reconcilePending(dependencies)
      .catch((cause) => {
        dependencies.log("delivery.reconciliation-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        reconciliation = undefined;
      });
  };

  return {
    start: async () => {
      await reconcilePending(dependencies);
      reconciliationTimer = setInterval(beginReconciliation, RECONCILIATION_INTERVAL_MS);
      dependencies.log("delivery.ready", {
        source: "drive-outbox-reconciliation",
        intervalMs: RECONCILIATION_INTERVAL_MS,
      });
    },
    stop: async () => {
      stopping = true;
      if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
      if (reconciliation !== undefined) await reconciliation;
    },
  };
};

import { createHash } from "node:crypto";
import {
  connect,
  consumerOpts,
  type JetStreamPullSubscription,
  type JsMsg,
  type NatsConnection,
} from "nats";
import { None, type Option, Some } from "../../domain/result.js";
import type { OutboxRepository } from "../application/outboxRepository.js";
import type { DeliveryDisposition, DeliveryLog, DeliveryProcessor } from "./deliveryProcessor.js";
import { outboxCreatedSubject, parseOutboxCreatedEvent } from "./outboxEvent.js";

const ACK_WAIT_MS = 300_000;
const ACK_CONFIRM_TIMEOUT_MS = 5_000;
const RECONCILIATION_INTERVAL_MS = 60_000;
const RECONCILIATION_PAGE_SIZE = 100;

export type DeliveryRuntime = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

type DeliveryRuntimeDependencies = {
  readonly natsUrl: string;
  readonly workspaceId: string;
  readonly repository: OutboxRepository;
  readonly processor: DeliveryProcessor;
  readonly log: DeliveryLog;
  readonly onFatal: (cause: unknown) => void;
};

export const deliveryConsumerName = (workspaceId: string): string =>
  `email-client-mcp-${createHash("sha256").update(workspaceId, "utf8").digest("hex").slice(0, 24)}`;

const acknowledge = async (message: JsMsg, log: DeliveryLog): Promise<void> => {
  const confirmed = await message.ackAck({ timeout: ACK_CONFIRM_TIMEOUT_MS });
  if (!confirmed) {
    log("delivery.ack-not-confirmed", { sequence: message.seq });
  }
};

const applyDisposition = async (
  message: JsMsg,
  disposition: DeliveryDisposition,
  log: DeliveryLog,
): Promise<void> => {
  if (disposition.kind === "Ack") {
    await acknowledge(message, log);
    return;
  }
  if (disposition.kind === "Reject") {
    log("delivery.event-rejected", { sequence: message.seq, reason: disposition.reason });
    message.term();
    return;
  }
  log("delivery.retry-scheduled", {
    sequence: message.seq,
    reason: disposition.reason,
    delayMs: disposition.delayMs,
  });
  message.nak(disposition.delayMs);
};

const decodeEvent = (message: JsMsg): unknown => {
  const text = new TextDecoder().decode(message.data);
  const decoded: unknown = JSON.parse(text);
  return decoded;
};

const handleMessage = async (
  message: JsMsg,
  dependencies: DeliveryRuntimeDependencies,
): Promise<void> => {
  let decoded: unknown;
  try {
    decoded = decodeEvent(message);
  } catch (cause) {
    dependencies.log("delivery.invalid-json-event", {
      sequence: message.seq,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    message.term();
    return;
  }
  const event = parseOutboxCreatedEvent(decoded, dependencies.workspaceId);
  if (event.tag === "Err") {
    dependencies.log("delivery.invalid-outbox-event", {
      sequence: message.seq,
      error: event.error.kind,
    });
    message.term();
    return;
  }
  const disposition = await dependencies.processor.process({
    kind: "EventLocator",
    externalId: event.value.externalId,
    account: event.value.account,
    mailboxId: event.value.mailboxId,
  });
  dependencies.log("delivery.event-processed", {
    eventId: event.value.eventId,
    externalId: event.value.externalId,
    disposition: disposition.kind,
  });
  await applyDisposition(message, disposition, dependencies.log);
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
  let connection: NatsConnection | undefined;
  let subscription: JetStreamPullSubscription | undefined;
  let consumeLoop: Promise<void> | undefined;
  let reconciliation: Promise<void> | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined;
  let stopping = false;

  const beginReconciliation = (): void => {
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
      connection = await connect({
        servers: dependencies.natsUrl,
        name: deliveryConsumerName(dependencies.workspaceId),
        maxReconnectAttempts: -1,
      });
      const options = consumerOpts();
      options
        .durable(deliveryConsumerName(dependencies.workspaceId))
        .deliverAll()
        .ackExplicit()
        .manualAck()
        .ackWait(ACK_WAIT_MS)
        .maxAckPending(1);
      const subject = outboxCreatedSubject(dependencies.workspaceId);
      subscription = await connection.jetstream().pullSubscribe(subject, options);
      const activeSubscription = subscription;
      activeSubscription.pull({ batch: 1 });
      consumeLoop = (async () => {
        for await (const message of activeSubscription) {
          await handleMessage(message, dependencies);
          if (!stopping) activeSubscription.pull({ batch: 1 });
        }
        if (!stopping) throw new Error("JetStream delivery subscription ended unexpectedly");
      })();
      consumeLoop.catch((cause) => {
        if (!stopping) dependencies.onFatal(cause);
      });

      await reconcilePending(dependencies);
      reconciliationTimer = setInterval(beginReconciliation, RECONCILIATION_INTERVAL_MS);
      dependencies.log("delivery.ready", {
        subject,
        consumer: deliveryConsumerName(dependencies.workspaceId),
      });
    },
    stop: async () => {
      stopping = true;
      if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
      if (reconciliation !== undefined) await reconciliation;
      if (subscription !== undefined) await subscription.drain();
      if (connection !== undefined) await connection.drain();
      if (consumeLoop !== undefined) await consumeLoop;
    },
  };
};

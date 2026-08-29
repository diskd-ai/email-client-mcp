import { Err, Ok, type Result } from "../../domain/result.js";
import type { JsonObject } from "./json.js";

export type DeliveryProgress =
  | {
      readonly kind: "DeliveryStarted";
      readonly messageId: string;
      readonly recordedAt: string;
    }
  | {
      readonly kind: "RetrySafe";
      readonly reason: string;
      readonly recordedAt: string;
    };

export type DeliveryProgressError = {
  readonly kind: "InvalidDeliveryProgress";
  readonly reason: string;
};

export const encodeDeliveryProgress = (progress: DeliveryProgress): JsonObject =>
  progress.kind === "DeliveryStarted"
    ? {
        deliveryProgress: "started",
        messageId: progress.messageId,
        recordedAt: progress.recordedAt,
      }
    : {
        deliveryProgress: "retry_safe",
        reason: progress.reason,
        recordedAt: progress.recordedAt,
      };

const readNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const decodeDeliveryProgress = (
  value: JsonObject,
): Result<DeliveryProgressError, DeliveryProgress> => {
  const discriminator = value.deliveryProgress;
  const recordedAt = readNonEmptyString(value.recordedAt);
  if (discriminator === "started") {
    const messageId = readNonEmptyString(value.messageId);
    if (messageId !== undefined && recordedAt !== undefined) {
      return Ok({ kind: "DeliveryStarted", messageId, recordedAt });
    }
  }
  if (discriminator === "retry_safe") {
    const reason = readNonEmptyString(value.reason);
    if (reason !== undefined && recordedAt !== undefined) {
      return Ok({ kind: "RetrySafe", reason, recordedAt });
    }
  }
  return Err({
    kind: "InvalidDeliveryProgress",
    reason: "Outbox result is not a recognized delivery progress marker",
  });
};

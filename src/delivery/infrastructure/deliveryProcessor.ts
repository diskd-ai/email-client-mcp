import type { Account } from "../../config/schema.js";
import { Err, None, type Option, type Result, Some } from "../../domain/result.js";
import { decideTransportOutcome } from "../application/decideTransportOutcome.js";
import type {
  OutboxItem,
  OutboxRepository,
  OutboxRepositoryError,
} from "../application/outboxRepository.js";
import { type DeliveryProgress, decodeDeliveryProgress } from "../domain/deliveryProgress.js";
import { resolveDeliveryIdentity } from "../domain/identity.js";
import type { JsonObject } from "../domain/json.js";
import type { DriveAttachmentLoadError, DriveAttachmentLoader } from "./driveAttachmentLoader.js";
import { parseEmailOutboxPayload } from "./emailOutboxPayload.js";
import type { PerAccountRateLimiter } from "./perAccountRateLimiter.js";
import type {
  SentFolderAppendError,
  SentFolderAppender,
  SentFolderAppendReceipt,
} from "./sentFolderAppender.js";
import type { SmtpSender } from "./smtpTransport.js";

const LEASE_SECONDS = 180;
const RETRY_AFTER_LEASE_MS = 185_000;
const RETRY_AFTER_CONFLICT_MS = 15_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const FAILED_UNKNOWN_REASON =
  "FailedUnknown: delivery started but no terminal SMTP outcome was durably recorded";

export type DeliveryDisposition =
  | { readonly kind: "Ack"; readonly reason: string }
  | { readonly kind: "Reject"; readonly reason: string }
  | { readonly kind: "Retry"; readonly reason: string; readonly delayMs: number };

export type DeliveryTarget =
  | {
      readonly kind: "EventLocator";
      readonly eventId: string;
      readonly externalId: string;
      readonly account: string;
      readonly mailboxId: string;
      readonly revision: string;
    }
  | { readonly kind: "Reconciliation"; readonly externalId: string };

export type DeliveryLog = (message: string, extra?: Readonly<Record<string, unknown>>) => void;

export type ConfiguredDeliveryAccount = {
  readonly config: Account;
  readonly sender: SmtpSender;
};

export type DeliveryProcessor = {
  readonly process: (target: DeliveryTarget) => Promise<DeliveryDisposition>;
};

type DeliveryProcessorDependencies = {
  readonly repository: OutboxRepository;
  readonly accounts: readonly ConfiguredDeliveryAccount[];
  readonly rateLimiter: PerAccountRateLimiter;
  readonly leaseOwner: string;
  readonly now: () => Date;
  readonly log: DeliveryLog;
  readonly attachmentLoader: DriveAttachmentLoader;
  readonly sentFolderAppender: SentFolderAppender;
};

const repositoryErrorReason = (error: OutboxRepositoryError): string =>
  error.kind === "InvalidResponse" || error.kind === "SdkFailure"
    ? `${error.operation} ${error.kind}: ${error.message}`
    : `${error.operation} ${error.kind}`;

const retryRepositoryError = (error: OutboxRepositoryError): DeliveryDisposition => ({
  kind: "Retry",
  reason: repositoryErrorReason(error),
  delayMs: RETRY_AFTER_CONFLICT_MS,
});

const receiptToJson = (receipt: {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly response: string;
}): JsonObject => ({
  messageId: receipt.messageId,
  accepted: receipt.accepted,
  rejected: receipt.rejected,
  response: receipt.response,
});

const sentFolderAppendToJson = (
  append: Result<SentFolderAppendError, SentFolderAppendReceipt>,
): JsonObject =>
  append.tag === "Ok"
    ? {
        status: "appended",
        folder: append.value.folder,
        uidValidity: append.value.uidValidity,
        uid: append.value.uid,
      }
    : {
        status: "failed",
        error: append.error.kind,
        ...(append.error.kind === "SentFolderMissing" ||
        append.error.kind === "SentAppendReceiptMissing"
          ? {}
          : { message: append.error.message }),
      };

const findConfiguredAccount = (
  accounts: readonly ConfiguredDeliveryAccount[],
  accountId: string,
): ConfiguredDeliveryAccount | undefined =>
  accounts.find((candidate) => candidate.config.name === accountId);

const claim = async (repository: OutboxRepository, item: OutboxItem, leaseOwner: string) =>
  repository.claim({
    externalId: item.externalId,
    expectedRevision: item.revision,
    leaseOwner,
    leaseSeconds: LEASE_SECONDS,
  });

const writeFailure = async (
  dependencies: DeliveryProcessorDependencies,
  item: OutboxItem,
  reason: string,
): Promise<DeliveryDisposition> => {
  const written = await dependencies.repository.writeTerminal({
    externalId: item.externalId,
    expectedRevision: item.revision,
    leaseOwner: dependencies.leaseOwner,
    outcome: { kind: "Failed", reason },
  });
  return written.tag === "Err" ? retryRepositoryError(written.error) : { kind: "Ack", reason };
};

const writeRetrySafe = async (
  dependencies: DeliveryProcessorDependencies,
  item: OutboxItem,
  reason: string,
): Promise<DeliveryDisposition> => {
  const retrySafe = await dependencies.repository.writeProgress({
    externalId: item.externalId,
    expectedRevision: item.revision,
    progress: {
      kind: "RetrySafe",
      reason,
      recordedAt: dependencies.now().toISOString(),
    },
  });
  return retrySafe.tag === "Err"
    ? retryRepositoryError(retrySafe.error)
    : { kind: "Retry", reason, delayMs: RETRY_AFTER_LEASE_MS };
};

const attachmentFailureReason = (error: DriveAttachmentLoadError): string =>
  error.kind === "AttachmentSizeExceeded"
    ? `Attachment exceeds ${error.maxTotalBytes} byte delivery limit: ${error.path}`
    : `Attachment download failed for ${error.path}: ${error.message}`;

const progressOption = (item: OutboxItem): Option<DeliveryProgress> => {
  if (item.result.tag === "None") return None;
  const decoded = decodeDeliveryProgress(item.result.value);
  return decoded.tag === "Ok"
    ? Some(decoded.value)
    : Some({
        kind: "DeliveryStarted",
        messageId: item.externalId,
        recordedAt: item.updatedAt,
      });
};

const reconcileStartedDelivery = async (
  dependencies: DeliveryProcessorDependencies,
  item: OutboxItem,
): Promise<DeliveryDisposition> => {
  const claimed = await claim(dependencies.repository, item, dependencies.leaseOwner);
  if (claimed.tag === "Err") return retryRepositoryError(claimed.error);
  return writeFailure(dependencies, claimed.value, FAILED_UNKNOWN_REASON);
};

const processOutbox = async (
  dependencies: DeliveryProcessorDependencies,
  item: OutboxItem,
): Promise<DeliveryDisposition> => {
  const progress = progressOption(item);
  if (progress.tag === "Some" && progress.value.kind === "DeliveryStarted") {
    return reconcileStartedDelivery(dependencies, item);
  }

  const payload = parseEmailOutboxPayload(item.payload, item.account);
  const configuredAccount = findConfiguredAccount(dependencies.accounts, item.account);
  if (payload.tag === "Err" || configuredAccount === undefined) {
    const claimed = await claim(dependencies.repository, item, dependencies.leaseOwner);
    if (claimed.tag === "Err") return retryRepositoryError(claimed.error);
    const reason =
      payload.tag === "Err"
        ? `Invalid outbound email payload: ${payload.error.issues.join("; ")}`
        : `Delivery account not configured: ${item.account}`;
    return writeFailure(dependencies, claimed.value, reason);
  }

  const identity = resolveDeliveryIdentity(
    dependencies.accounts.map((account) => ({
      accountId: account.config.name,
      allowedFromAddresses: [account.config.email],
    })),
    item.account,
    payload.value.from.address,
  );
  if (identity.tag === "Err") {
    const claimed = await claim(dependencies.repository, item, dependencies.leaseOwner);
    if (claimed.tag === "Err") return retryRepositoryError(claimed.error);
    return writeFailure(
      dependencies,
      claimed.value,
      `Invalid delivery identity: ${identity.error.kind}`,
    );
  }

  await dependencies.rateLimiter.waitForTurn(item.account);
  const claimed = await claim(dependencies.repository, item, dependencies.leaseOwner);
  if (claimed.tag === "Err") return retryRepositoryError(claimed.error);
  if (claimed.value.deliveryAttempts > MAX_DELIVERY_ATTEMPTS) {
    return writeFailure(dependencies, claimed.value, "Delivery attempt limit exceeded");
  }

  const attachments = await dependencies.attachmentLoader.load(payload.value.attachments);
  if (attachments.tag === "Err") {
    const reason = attachmentFailureReason(attachments.error);
    dependencies.log("delivery.attachment-load-failed", {
      externalId: item.externalId,
      account: item.account,
      error: attachments.error.kind,
      reason,
    });
    return attachments.error.kind === "AttachmentSizeExceeded"
      ? writeFailure(dependencies, claimed.value, reason)
      : writeRetrySafe(dependencies, claimed.value, reason);
  }

  const startedAt = dependencies.now().toISOString();
  const marked = await dependencies.repository.writeProgress({
    externalId: item.externalId,
    expectedRevision: claimed.value.revision,
    progress: {
      kind: "DeliveryStarted",
      messageId: payload.value.messageId,
      recordedAt: startedAt,
    },
  });
  if (marked.tag === "Err") return retryRepositoryError(marked.error);

  const outcome = await configuredAccount.sender.send({
    payload: payload.value,
    attachments: attachments.value,
    fromAddress: identity.value.fromAddress,
    fromName: configuredAccount.config.full_name ?? configuredAccount.config.email,
  });
  dependencies.log("delivery.smtp-outcome", {
    externalId: item.externalId,
    account: item.account,
    outcome: outcome.kind,
  });
  const decision = decideTransportOutcome(outcome);
  if (decision.kind === "RecordSent" && outcome.kind === "Accepted") {
    let sentFolderAppend: Result<SentFolderAppendError, SentFolderAppendReceipt>;
    try {
      sentFolderAppend = await dependencies.sentFolderAppender.append(
        item.account,
        outcome.rawMessage,
        dependencies.now(),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      dependencies.log("delivery.sent-append-threw", {
        externalId: item.externalId,
        account: item.account,
        error: message,
      });
      sentFolderAppend = Err({ kind: "SentAppendFailed", accountId: item.account, message });
    }
    dependencies.log("delivery.sent-append", {
      externalId: item.externalId,
      account: item.account,
      status: sentFolderAppend.tag === "Ok" ? "appended" : "failed",
      ...(sentFolderAppend.tag === "Err" ? { error: sentFolderAppend.error.kind } : {}),
    });
    const written = await dependencies.repository.writeTerminal({
      externalId: item.externalId,
      expectedRevision: marked.value.revision,
      leaseOwner: dependencies.leaseOwner,
      outcome: {
        kind: "Sent",
        providerResponse: {
          ...receiptToJson(outcome.receipt),
          sentFolderAppend: sentFolderAppendToJson(sentFolderAppend),
        },
      },
    });
    return written.tag === "Err"
      ? retryRepositoryError(written.error)
      : { kind: "Ack", reason: "SMTP accepted and Drive recorded Sent" };
  }
  if (decision.kind === "ScheduleRetry") {
    if (marked.value.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
      return writeFailure(
        dependencies,
        marked.value,
        `Delivery attempt limit exceeded: ${decision.reason}`,
      );
    }
    return writeRetrySafe(dependencies, marked.value, decision.reason);
  }
  if (decision.kind === "RecordSent") {
    return writeFailure(
      dependencies,
      marked.value,
      "FailedUnknown: accepted transport decision did not include an acceptance receipt",
    );
  }
  return writeFailure(
    dependencies,
    marked.value,
    decision.kind === "RecordFailedUnknown" ? `FailedUnknown: ${decision.reason}` : decision.reason,
  );
};

export const buildDeliveryProcessor = (
  dependencies: DeliveryProcessorDependencies,
): DeliveryProcessor => {
  const inFlight = new Set<string>();
  return {
    process: async (target) => {
      const externalId = target.externalId;
      if (inFlight.has(externalId)) {
        return { kind: "Retry", reason: "delivery already in progress", delayMs: 5_000 };
      }
      inFlight.add(externalId);
      try {
        dependencies.log("delivery.processing", {
          externalId,
          source: target.kind,
          ...(target.kind === "EventLocator"
            ? { eventId: target.eventId, eventRevision: target.revision }
            : {}),
        });
        const loaded = await dependencies.repository.get(externalId);
        if (loaded.tag === "Err") return retryRepositoryError(loaded.error);
        if (
          target.kind === "EventLocator" &&
          (target.account !== loaded.value.account || target.mailboxId !== loaded.value.mailboxId)
        ) {
          return {
            kind: "Reject",
            reason: "event locator does not match the stored Outbox item",
          };
        }
        if (target.kind === "EventLocator" && target.revision !== loaded.value.revision) {
          dependencies.log("delivery.event-revision-mismatch", {
            externalId,
            eventId: target.eventId,
            eventRevision: target.revision,
            storedRevision: loaded.value.revision,
          });
        }
        if (loaded.value.state !== "outbox") {
          return { kind: "Ack", reason: `item is already ${loaded.value.state}` };
        }
        return await processOutbox(dependencies, loaded.value);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        dependencies.log("delivery.processor-error", { externalId, error: reason });
        return { kind: "Retry", reason, delayMs: RETRY_AFTER_CONFLICT_MS };
      } finally {
        inFlight.delete(externalId);
      }
    },
  };
};

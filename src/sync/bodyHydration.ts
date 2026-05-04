import {
  type AppError,
  errorMessage,
  type ImapError,
  isRetryableImapError,
  notFound,
} from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { htmlToText } from "../imap/mapper.js";
import type { StoredEmailPayload } from "../store/payloadTypes.js";

export type FetchedBodyContent = {
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly truncated: boolean;
  readonly bytesRead: number;
};

export type BodyHydrationRef = {
  readonly mailboxId: string;
  readonly folderId: string;
  readonly externalId: string;
};

export type BodyHydrationDeps = {
  readonly drive: {
    readonly getMessage: (
      mailboxId: string,
      folderId: string,
      externalId: string,
    ) => Promise<Result<AppError, StoredEmailPayload | null>>;
    readonly upsertMessages: (
      mailboxId: string,
      folderId: string,
      payloads: readonly StoredEmailPayload[],
      externalIds: readonly string[],
    ) => Promise<Result<AppError, { inserted: number; updated: number }>>;
  };
  readonly imap: {
    readonly fetchBody: (
      accountId: string,
      mailbox: string,
      uid: number,
    ) => Promise<Result<ImapError, FetchedBodyContent | null>>;
  };
  readonly now: () => Date;
};

export type BodyHydrationStatus = "loaded" | "skipped" | "failed_retryable" | "failed_permanent";

export type BodyHydrationOutcome = {
  readonly status: BodyHydrationStatus;
  readonly payload: StoredEmailPayload;
  readonly error: string | null;
};

export type BodyHydrationBatchItem = BodyHydrationOutcome & {
  readonly ref: BodyHydrationRef;
};

export type BodyHydrationBatchResult = {
  readonly loaded: readonly BodyHydrationBatchItem[];
  readonly skipped: readonly BodyHydrationBatchItem[];
  readonly failedRetryable: readonly BodyHydrationBatchItem[];
  readonly failedPermanent: readonly BodyHydrationBatchItem[];
};

const buildSnippet = (bodyText: string | null, bodyHtml: string | null): string => {
  const text = bodyText ?? (bodyHtml !== null ? htmlToText(bodyHtml) : null);
  if (text === null) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
};

const messageHasLoadedBody = (payload: StoredEmailPayload): boolean =>
  payload.bodyState === "loaded" ||
  (payload.bodyState === undefined && (payload.bodyText !== null || payload.bodyHtml !== null));

export const markBodyLoaded = (
  payload: StoredEmailPayload,
  body: FetchedBodyContent,
  now: Date,
): StoredEmailPayload => ({
  ...payload,
  snippet: buildSnippet(body.bodyText, body.bodyHtml),
  bodyText: body.bodyText,
  bodyHtml: body.bodyHtml,
  truncated: payload.truncated || body.truncated,
  bodyState: "loaded",
  bodyFetchedAt: now.toISOString(),
  bodyFetchError: null,
});

export const markBodyFailedRetryable = (
  payload: StoredEmailPayload,
  error: string,
  now: Date,
): StoredEmailPayload => ({
  ...payload,
  bodyState: "failed_retryable",
  bodyFetchedAt: now.toISOString(),
  bodyFetchError: error,
});

export const markBodyFailedPermanent = (
  payload: StoredEmailPayload,
  error: string,
  now: Date,
): StoredEmailPayload => ({
  ...payload,
  bodyState: "failed_permanent",
  bodyFetchedAt: now.toISOString(),
  bodyFetchError: error,
});

const persistBodyState = async (
  deps: BodyHydrationDeps,
  ref: BodyHydrationRef,
  payload: StoredEmailPayload,
): Promise<Result<AppError, StoredEmailPayload>> => {
  const upsert = await deps.drive.upsertMessages(
    ref.mailboxId,
    ref.folderId,
    [payload],
    [ref.externalId],
  );
  if (upsert.tag === "Err") return upsert;
  return Ok(payload);
};

const imapFailureIsRetryable = (error: ImapError): boolean =>
  isRetryableImapError(error.message) || isRetryableImapError(error.cause);

export const hydrateStoredMessageBody = async (
  deps: BodyHydrationDeps,
  ref: BodyHydrationRef,
  options?: { readonly refresh?: boolean },
): Promise<Result<AppError, BodyHydrationOutcome>> => {
  const existing = await deps.drive.getMessage(ref.mailboxId, ref.folderId, ref.externalId);
  if (existing.tag === "Err") return existing;
  if (existing.value === null) return Err(notFound(`message ${ref.externalId}`));

  const payload = existing.value;
  if (options?.refresh !== true && messageHasLoadedBody(payload)) {
    return Ok({ status: "skipped", payload, error: null });
  }

  const fetched = await deps.imap.fetchBody(payload.accountId, payload.mailbox, payload.uid);
  if (fetched.tag === "Err") {
    const message = errorMessage(fetched.error);
    const patched = imapFailureIsRetryable(fetched.error)
      ? markBodyFailedRetryable(payload, message, deps.now())
      : markBodyFailedPermanent(payload, message, deps.now());
    const persisted = await persistBodyState(deps, ref, patched);
    if (persisted.tag === "Err") return persisted;
    return Ok({
      status: imapFailureIsRetryable(fetched.error) ? "failed_retryable" : "failed_permanent",
      payload: persisted.value,
      error: message,
    });
  }

  if (fetched.value === null) {
    const message = `message body not found: ${ref.externalId}`;
    const patched = markBodyFailedPermanent(payload, message, deps.now());
    const persisted = await persistBodyState(deps, ref, patched);
    if (persisted.tag === "Err") return persisted;
    return Ok({ status: "failed_permanent", payload: persisted.value, error: message });
  }

  const patched = markBodyLoaded(payload, fetched.value, deps.now());
  const persisted = await persistBodyState(deps, ref, patched);
  if (persisted.tag === "Err") return persisted;
  return Ok({ status: "loaded", payload: persisted.value, error: null });
};

export const hydrateStoredMessageBodies = async (
  deps: BodyHydrationDeps,
  refs: readonly BodyHydrationRef[],
  options?: { readonly refresh?: boolean; readonly maxMessages?: number },
): Promise<Result<AppError, BodyHydrationBatchResult>> => {
  const maxMessages = options?.maxMessages ?? refs.length;
  const selectedRefs = refs.slice(0, Math.max(0, maxMessages));
  const loaded: BodyHydrationBatchItem[] = [];
  const skipped: BodyHydrationBatchItem[] = [];
  const failedRetryable: BodyHydrationBatchItem[] = [];
  const failedPermanent: BodyHydrationBatchItem[] = [];

  for (const ref of selectedRefs) {
    const result = await hydrateStoredMessageBody(deps, ref, { refresh: options?.refresh });
    if (result.tag === "Err") return result;
    const item = { ...result.value, ref };
    if (item.status === "loaded") loaded.push(item);
    else if (item.status === "skipped") skipped.push(item);
    else if (item.status === "failed_retryable") failedRetryable.push(item);
    else failedPermanent.push(item);
  }

  return Ok({ loaded, skipped, failedRetryable, failedPermanent });
};

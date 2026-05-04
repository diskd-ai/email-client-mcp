import { type AppError, errorMessage, isRetryableImapError, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { attachmentIdFor, type UploadAttachmentResult } from "../store/attachments.js";
import type { StoredAttachment, StoredEmailPayload } from "../store/payloadTypes.js";

export type AttachmentHydrationRef = {
  readonly mailboxId: string;
  readonly folderId: string;
  readonly externalId: string;
  readonly attachmentId: string;
};

export type AttachmentHydrationDeps = {
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
    readonly uploadAttachment: (
      mailboxId: string,
      folderId: string,
      externalId: string,
      attachment: StoredAttachment & { readonly attachmentId: string },
      content: AsyncIterable<Uint8Array>,
    ) => Promise<Result<AppError, UploadAttachmentResult>>;
  };
  readonly imap: {
    readonly downloadPart: (
      accountId: string,
      mailbox: string,
      uid: number,
      partId: string,
    ) => Promise<{
      readonly content: AsyncIterable<Uint8Array>;
      readonly sizeBytes: number | null;
      readonly contentType: string | null;
      readonly dispose: () => void;
    }>;
  };
};

export type AttachmentHydrationStatus =
  | "loaded"
  | "skipped"
  | "failed_retryable"
  | "failed_permanent";

export type AttachmentHydrationOutcome = {
  readonly status: AttachmentHydrationStatus;
  readonly mailboxId: string;
  readonly folderId: string;
  readonly externalId: string;
  readonly attachmentId: string;
  readonly attachment: StoredAttachment | null;
  readonly payload: StoredEmailPayload;
  readonly error: string | null;
};

const resolvedAttachmentId = (payload: StoredEmailPayload, attachment: StoredAttachment): string =>
  attachment.attachmentId ?? attachmentIdFor(payload.uidValidity, payload.uid, attachment.partId);

const findAttachment = (
  payload: StoredEmailPayload,
  attachmentId: string,
): StoredAttachment | null =>
  payload.attachments.find(
    (attachment) => resolvedAttachmentId(payload, attachment) === attachmentId,
  ) ?? null;

const patchAttachment = (
  payload: StoredEmailPayload,
  attachmentId: string,
  patch: (attachment: StoredAttachment & { readonly attachmentId: string }) => StoredAttachment,
): { readonly payload: StoredEmailPayload; readonly attachment: StoredAttachment | null } => {
  let patchedAttachment: StoredAttachment | null = null;
  const attachments = payload.attachments.map((attachment) => {
    const nextAttachment = {
      ...attachment,
      attachmentId: resolvedAttachmentId(payload, attachment),
    };
    if (nextAttachment.attachmentId !== attachmentId) return nextAttachment;
    patchedAttachment = patch(nextAttachment);
    return patchedAttachment;
  });
  return { payload: { ...payload, attachments }, attachment: patchedAttachment };
};

const patchLoaded = (
  payload: StoredEmailPayload,
  attachmentId: string,
  uploaded: UploadAttachmentResult,
): { readonly payload: StoredEmailPayload; readonly attachment: StoredAttachment | null } =>
  patchAttachment(payload, attachmentId, (attachment) => {
    const { lastLoadError: _lastLoadError, ...rest } = attachment;
    return {
      ...rest,
      storageState: "loaded",
      storedSizeBytes: uploaded.storedSizeBytes,
      storedAt: uploaded.storedAt,
    };
  });

const patchFailed = (
  payload: StoredEmailPayload,
  attachmentId: string,
  status: "failed_retryable" | "failed_permanent",
  message: string,
): { readonly payload: StoredEmailPayload; readonly attachment: StoredAttachment | null } =>
  patchAttachment(payload, attachmentId, (attachment) => ({
    ...attachment,
    storageState: status,
    lastLoadError: message,
  }));

const persist = async (
  deps: AttachmentHydrationDeps,
  ref: AttachmentHydrationRef,
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

const isRetryableAppFailure = (cause: unknown): boolean => isRetryableImapError(cause);

const outcome = (
  ref: AttachmentHydrationRef,
  payload: StoredEmailPayload,
  status: AttachmentHydrationStatus,
  attachment: StoredAttachment | null,
  error: string | null,
): AttachmentHydrationOutcome => ({
  status,
  mailboxId: ref.mailboxId,
  folderId: ref.folderId,
  externalId: ref.externalId,
  attachmentId: ref.attachmentId,
  attachment,
  payload,
  error,
});

export const hydrateStoredMessageAttachment = async (
  deps: AttachmentHydrationDeps,
  ref: AttachmentHydrationRef,
  options?: { readonly refresh?: boolean },
): Promise<Result<AppError, AttachmentHydrationOutcome>> => {
  const existing = await deps.drive.getMessage(ref.mailboxId, ref.folderId, ref.externalId);
  if (existing.tag === "Err") return existing;
  if (existing.value === null) return Err(notFound(`message ${ref.externalId}`));

  const payload = existing.value;
  const attachment = findAttachment(payload, ref.attachmentId);
  if (attachment === null) {
    return Ok(
      outcome(ref, payload, "failed_permanent", null, `attachment not found: ${ref.attachmentId}`),
    );
  }
  const attachmentWithId = {
    ...attachment,
    attachmentId: resolvedAttachmentId(payload, attachment),
  };
  if (attachmentWithId.storageState === "loaded" && options?.refresh !== true) {
    return Ok(outcome(ref, payload, "skipped", attachmentWithId, null));
  }
  if (attachmentWithId.partId.length === 0) {
    const message = `attachment partId is missing: ${ref.attachmentId}`;
    const patched = patchFailed(payload, ref.attachmentId, "failed_permanent", message);
    const persisted = await persist(deps, ref, patched.payload);
    if (persisted.tag === "Err") return persisted;
    return Ok(outcome(ref, persisted.value, "failed_permanent", patched.attachment, message));
  }

  let downloaded: Awaited<ReturnType<AttachmentHydrationDeps["imap"]["downloadPart"]>>;
  try {
    downloaded = await deps.imap.downloadPart(
      payload.accountId,
      payload.mailbox,
      payload.uid,
      attachmentWithId.partId,
    );
  } catch (cause) {
    const message = (cause as Error)?.message ?? String(cause);
    const status = isRetryableAppFailure(cause) ? "failed_retryable" : "failed_permanent";
    const patched = patchFailed(payload, ref.attachmentId, status, message);
    const persisted = await persist(deps, ref, patched.payload);
    if (persisted.tag === "Err") return persisted;
    return Ok(outcome(ref, persisted.value, status, patched.attachment, message));
  }

  const uploadAttachment = {
    ...attachmentWithId,
    sizeBytes: downloaded.sizeBytes ?? attachmentWithId.sizeBytes,
    contentType: downloaded.contentType ?? attachmentWithId.contentType,
  };
  const uploaded = await (async () => {
    try {
      return await deps.drive.uploadAttachment(
        ref.mailboxId,
        ref.folderId,
        ref.externalId,
        uploadAttachment,
        downloaded.content,
      );
    } finally {
      downloaded.dispose();
    }
  })();
  if (uploaded.tag === "Err") {
    const message = errorMessage(uploaded.error);
    const status = isRetryableAppFailure(message) ? "failed_retryable" : "failed_permanent";
    const patched = patchFailed(payload, ref.attachmentId, status, message);
    const persisted = await persist(deps, ref, patched.payload);
    if (persisted.tag === "Err") return persisted;
    return Ok(outcome(ref, persisted.value, status, patched.attachment, message));
  }

  const patched = patchLoaded(payload, ref.attachmentId, uploaded.value);
  const persisted = await persist(deps, ref, patched.payload);
  if (persisted.tag === "Err") return persisted;
  return Ok(outcome(ref, persisted.value, "loaded", patched.attachment, null));
};

/**
 * Adapter over `diskd.os.messagesStore`. Wraps each call in
 * try/catch -> typed `DriveError` so the sync core stays pure-ish
 * (Result-returning) and we can compose retries with backoff.
 *
 * One mailbox per account: ensureMailbox is idempotent; the underlying
 * `createMailbox` errors (e.g. ALREADY_EXISTS) are absorbed -- callers
 * do not need to track creation state.
 */

import type { diskd as DiskdNs } from "@diskd-ai/sdk";
import { type DriveError, driveError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { isValidMailboxId } from "./conventions.js";
import type { StoredAttachment, StoredEmailPayload, SyncState } from "./payloadTypes.js";

type MessagesStore = ReturnType<typeof DiskdNs.os.messagesStore>;
type MailboxScoped = ReturnType<MessagesStore["mailbox"]>;
type FolderScoped = ReturnType<MailboxScoped["folder"]>;

type AttachmentScoped = ReturnType<FolderScoped["message"]>["attachments"];

type IdempotentUploadStartResult = {
  readonly alreadyUploaded?: boolean;
  readonly intentId?: string | null;
  readonly uploadUrl?: string | null;
  readonly attachmentId?: string;
  readonly sizeBytes?: number;
  readonly createdAt?: string;
};

export type UploadAttachmentInput = StoredAttachment & {
  readonly attachmentId: string;
};

export type UploadAttachmentResult = {
  readonly attachmentId: string;
  readonly storedSizeBytes: number;
  readonly storedAt: string;
};

export type DriveStore = {
  /** Ensure mailbox exists and SQLite schema is bootstrapped. */
  readonly ensureMailbox: (
    mailboxId: string,
    displayName: string,
  ) => Promise<Result<DriveError, void>>;
  readonly listMailboxes: () => Promise<Result<DriveError, readonly string[]>>;
  readonly upsertFolder: (
    mailboxId: string,
    folderId: string,
    displayName: string,
    metadata: SyncState,
  ) => Promise<Result<DriveError, void>>;
  readonly getFolder: (
    mailboxId: string,
    folderId: string,
  ) => Promise<Result<DriveError, { metadata: Readonly<Record<string, unknown>> } | null>>;
  readonly listFolders: (
    mailboxId: string,
  ) => Promise<Result<DriveError, readonly { folderId: string; messageCount: number }[]>>;
  readonly deleteFolder: (
    mailboxId: string,
    folderId: string,
  ) => Promise<Result<DriveError, { deletedMessageCount: number }>>;
  readonly upsertMessages: (
    mailboxId: string,
    folderId: string,
    payloads: readonly StoredEmailPayload[],
    externalIds: readonly string[],
  ) => Promise<Result<DriveError, { inserted: number; updated: number }>>;
  readonly getMessage: (
    mailboxId: string,
    folderId: string,
    externalId: string,
  ) => Promise<Result<DriveError, StoredEmailPayload | null>>;
  readonly uploadAttachment: (
    mailboxId: string,
    folderId: string,
    externalId: string,
    attachment: UploadAttachmentInput,
    content: AsyncIterable<Uint8Array>,
  ) => Promise<Result<DriveError, UploadAttachmentResult>>;
};

const wrap = async <T>(what: string, fn: () => Promise<T>): Promise<Result<DriveError, T>> => {
  try {
    return Ok(await fn());
  } catch (cause) {
    return Err(driveError(`${what} failed: ${(cause as Error)?.message ?? String(cause)}`, cause));
  }
};

const folderScoped = (store: MessagesStore, mailboxId: string, folderId: string): FolderScoped =>
  store.mailbox({ mailboxId }).folder({ folderId });

const attachmentScoped = (
  store: MessagesStore,
  mailboxId: string,
  folderId: string,
  externalId: string,
): AttachmentScoped => folderScoped(store, mailboxId, folderId).message({ externalId }).attachments;

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

const resolveDiskdBaseUrl = (): string => {
  const base = process.env.APIS_BASE_URL;
  if (base === undefined || base.length === 0) {
    throw new Error("APIS_BASE_URL is not set");
  }
  return stripTrailingSlashes(base);
};

const resolveDriveRpcUrl = (): string => {
  const base = resolveDiskdBaseUrl();
  return base.endsWith("/v1") ? `${base}/os/drive/api/v1` : `${base}/v1/os/drive/api/v1`;
};

const resolveUploadUrl = (uploadUrl: string): string => {
  if (/^https?:\/\//i.test(uploadUrl)) return uploadUrl;
  const rpcUrl = resolveDriveRpcUrl();
  const driveBase = rpcUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${driveBase}${uploadUrl.startsWith("/") ? uploadUrl : `/${uploadUrl}`}`;
};

const uploadAuthHeaders = (): Record<string, string> => {
  const apiKey = process.env.APIS_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("APIS_API_KEY is not set");
  }
  const workspaceId = process.env.APIS_WORKSPACE_ID ?? process.env.MCP_HUB_WORKSPACE_ID;
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new Error("workspace id is not set");
  }
  return {
    "X-Api-Key": apiKey,
    "X-Workspace-Id": workspaceId,
    "X-User-Id": workspaceId,
    "X-Organization-Id": workspaceId,
  };
};

const isConflict = (cause: unknown): boolean =>
  /CONFLICT|already exists/i.test((cause as Error)?.message ?? String(cause));

const matchExistingAttachment = (
  existing: {
    readonly attachmentId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly driveInode: string;
  },
  expected: UploadAttachmentInput,
): boolean =>
  existing.attachmentId === expected.attachmentId &&
  existing.filename === expected.filename &&
  existing.contentType === expected.contentType &&
  existing.sizeBytes === expected.sizeBytes;

export const buildDriveStore = (store: MessagesStore): DriveStore => ({
  async ensureMailbox(mailboxId, displayName) {
    if (!isValidMailboxId(mailboxId)) {
      return Err(driveError(`mailboxId '${mailboxId}' is not a valid slug`));
    }
    const list = await wrap("listMailboxes", () => store.listMailboxes());
    if (list.tag === "Err") return list;
    const exists = list.value.some((m) => m.mailboxId === mailboxId);
    if (!exists) {
      const create = await wrap("createMailbox", () =>
        store.createMailbox({ mailboxId, displayName }),
      );
      if (create.tag === "Err") return create;
    }
    const init = await wrap("mailbox.init", () => store.mailbox({ mailboxId }).init());
    if (init.tag === "Err") return init;
    return Ok(undefined);
  },
  async listMailboxes() {
    const r = await wrap("listMailboxes", () => store.listMailboxes());
    if (r.tag === "Err") return r;
    return Ok(r.value.map((m) => m.mailboxId));
  },
  async upsertFolder(mailboxId, folderId, displayName, metadata) {
    const r = await wrap("upsertFolder", () =>
      store.mailbox({ mailboxId }).upsertFolder({
        folderId,
        displayName,
        metadata: metadata as unknown as Readonly<Record<string, unknown>>,
      }),
    );
    if (r.tag === "Err") return r;
    return Ok(undefined);
  },
  async getFolder(mailboxId, folderId) {
    try {
      const summary = await folderScoped(store, mailboxId, folderId).get();
      return Ok({ metadata: summary.metadata });
    } catch (cause) {
      const msg = (cause as Error)?.message ?? String(cause);
      if (/not found|FOLDER_NOT_FOUND|404/i.test(msg)) {
        return Ok(null);
      }
      return Err(driveError(`folder.get failed: ${msg}`, cause));
    }
  },
  async listFolders(mailboxId) {
    const r = await wrap("listFolders", () => store.mailbox({ mailboxId }).listFolders());
    if (r.tag === "Err") return r;
    return Ok(r.value.map((f) => ({ folderId: f.folderId, messageCount: f.messageCount })));
  },
  async deleteFolder(mailboxId, folderId) {
    const r = await wrap("folder.delete", () => folderScoped(store, mailboxId, folderId).delete());
    if (r.tag === "Err") return r;
    return Ok({ deletedMessageCount: r.value.deletedMessageCount });
  },
  async upsertMessages(mailboxId, folderId, payloads, externalIds) {
    if (payloads.length === 0) return Ok({ inserted: 0, updated: 0 });
    const items = payloads.map((p, i) => ({
      externalId: externalIds[i] as string,
      payload: p as unknown as Readonly<Record<string, unknown>>,
    }));
    const r = await wrap("folder.upsertBatch", () =>
      folderScoped(store, mailboxId, folderId).upsertBatch({ items, autoCommit: false }),
    );
    if (r.tag === "Err") return r;
    return Ok({ inserted: r.value.inserted, updated: r.value.updated });
  },
  async getMessage(mailboxId, folderId, externalId) {
    try {
      const message = await folderScoped(store, mailboxId, folderId).getMessage({ externalId });
      return Ok(message.payload as unknown as StoredEmailPayload);
    } catch (cause) {
      const msg = (cause as Error)?.message ?? String(cause);
      if (/not found|MESSAGE_NOT_FOUND|404/i.test(msg)) {
        return Ok(null);
      }
      return Err(driveError(`folder.getMessage failed: ${msg}`, cause));
    }
  },
  async uploadAttachment(mailboxId, folderId, externalId, attachment, content) {
    const attachments = attachmentScoped(store, mailboxId, folderId, externalId);
    const existingResult = async (): Promise<Result<DriveError, UploadAttachmentResult>> => {
      const listed = await attachments.list();
      const existing = listed.find((item) => item.attachmentId === attachment.attachmentId);
      if (existing === undefined) {
        return Err(
          driveError(
            `attachment conflict but existing row was not found: ${attachment.attachmentId}`,
          ),
        );
      }
      if (!matchExistingAttachment(existing, attachment)) {
        return Err(
          driveError(`attachment conflict with mismatched metadata: ${attachment.attachmentId}`),
        );
      }
      return Ok({
        attachmentId: existing.attachmentId,
        storedSizeBytes: existing.sizeBytes,
        storedAt: existing.createdAt,
      });
    };

    return await wrap("attachment.upload", async () => {
      let start: IdempotentUploadStartResult;
      try {
        start = (await attachments.uploadStart({
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          autoCommit: false,
        })) as IdempotentUploadStartResult;
      } catch (cause) {
        if (!isConflict(cause)) throw cause;
        const existing = await existingResult();
        if (existing.tag === "Err")
          throw new Error(existing.error.message, { cause: existing.error });
        return existing.value;
      }
      if (start.alreadyUploaded === true) {
        return {
          attachmentId: start.attachmentId ?? attachment.attachmentId,
          storedSizeBytes: start.sizeBytes ?? attachment.sizeBytes,
          storedAt: start.createdAt ?? new Date().toISOString(),
        };
      }
      if (!start.intentId || !start.uploadUrl) {
        throw new Error("attachment.uploadStart response missing upload intent");
      }
      const uploadUrl = resolveUploadUrl(start.uploadUrl);
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          ...uploadAuthHeaders(),
          "Content-Type": attachment.contentType,
          "Content-Length": String(attachment.sizeBytes),
          "X-Upload-Intent-Id": start.intentId,
        },
        body: content as never,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (!put.ok) {
        const text = await put.text();
        throw new Error(`Upload PUT failed (HTTP ${put.status}): ${text.slice(0, 200)}`);
      }
      const putBody = (await put.json()) as { readonly etag?: string };
      const etag = putBody.etag ?? put.headers.get("etag") ?? "";
      if (!etag) {
        throw new Error("Upload PUT response missing etag");
      }
      try {
        const commit = await attachments.uploadCommit({
          attachmentId: attachment.attachmentId,
          intentId: start.intentId,
          etag,
          autoCommit: false,
        });
        return {
          attachmentId: commit.attachmentId,
          storedSizeBytes: commit.sizeBytes,
          storedAt: new Date().toISOString(),
        };
      } catch (cause) {
        if (!isConflict(cause)) throw cause;
        const existing = await existingResult();
        if (existing.tag === "Err")
          throw new Error(existing.error.message, { cause: existing.error });
        return existing.value;
      }
    });
  },
});

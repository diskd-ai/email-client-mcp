/**
 * Adapter over `diskd.os.messagesStore`. Wraps each call in
 * try/catch -> typed `DriveError` so the sync core stays pure-ish
 * (Result-returning) and we can compose retries with backoff.
 *
 * One mailbox per account: ensureMailbox is idempotent; the underlying
 * `createMailbox` errors (e.g. ALREADY_EXISTS) are absorbed -- callers
 * do not need to track creation state.
 */

import type { diskd as DiskdNs } from "@diskd/sdk";
import { type DriveError, driveError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { isValidMailboxId } from "./conventions.js";
import type { StoredEmailPayload, SyncState } from "./payloadTypes.js";

type MessagesStore = ReturnType<typeof DiskdNs.os.messagesStore>;
type MailboxScoped = ReturnType<MessagesStore["mailbox"]>;
type FolderScoped = ReturnType<MailboxScoped["folder"]>;

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
});

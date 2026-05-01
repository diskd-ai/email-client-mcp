/**
 * The reliability core. `runSyncOnce(account)` performs one watcher
 * pass for one account.
 *
 * Invariants enforced here:
 *  1. `lastSyncedUid` is advanced ONLY after a successful upsertBatch.
 *     A crash mid-tick or a Drive 5xx leaves the checkpoint untouched,
 *     so the next tick re-fetches the unprocessed UIDs (idempotent
 *     because externalId is `${UIDVALIDITY}:${UID}`).
 *  2. UIDVALIDITY mismatch -> drop+recreate folder, resync from UID 1.
 *  3. Folder metadata is the source of truth across restarts. The
 *     watcher never relies on in-memory state to resume.
 *  4. Folders deleted in IMAP are pruned from Drive at the end of a tick.
 *  5. A bounded sliding-window flag reconciliation catches drift on
 *     already-synced UIDs without re-downloading bodies.
 *
 * The function takes injected dependencies (drive store, IMAP client
 * factory, mapper) so unit tests can drive it without real I/O.
 */

import { type Account, isOAuthAccount, type WatcherSettings } from "../config/schema.js";
import { type AppError, errorMessage, type ImapError, imapError } from "../domain/errors.js";
import { Err, type Result } from "../domain/result.js";
import { type FetchedMessageLike, toStoredPayload } from "../imap/mapper.js";
import {
  patchAttachmentStorageRef,
  type UploadAttachmentResult,
  withAttachmentId,
} from "../store/attachments.js";
import { externalIdFor, sanitizeMailboxId } from "../store/conventions.js";
import type { StoredAttachment, StoredEmailPayload, SyncState } from "../store/payloadTypes.js";

const BATCH_SIZE = 50;

export type SyncDeps = {
  readonly drive: {
    readonly ensureMailbox: (
      mailboxId: string,
      displayName: string,
    ) => Promise<Result<AppError, void>>;
    readonly upsertFolder: (
      mailboxId: string,
      folderId: string,
      displayName: string,
      metadata: SyncState,
    ) => Promise<Result<AppError, void>>;
    readonly getFolder: (
      mailboxId: string,
      folderId: string,
    ) => Promise<Result<AppError, { metadata: Readonly<Record<string, unknown>> } | null>>;
    readonly listFolders: (
      mailboxId: string,
    ) => Promise<Result<AppError, readonly { folderId: string; messageCount: number }[]>>;
    readonly deleteFolder: (
      mailboxId: string,
      folderId: string,
    ) => Promise<Result<AppError, { deletedMessageCount: number }>>;
    readonly upsertMessages: (
      mailboxId: string,
      folderId: string,
      payloads: readonly StoredEmailPayload[],
      externalIds: readonly string[],
    ) => Promise<Result<AppError, { inserted: number; updated: number }>>;
    readonly getMessage: (
      mailboxId: string,
      folderId: string,
      externalId: string,
    ) => Promise<Result<AppError, StoredEmailPayload | null>>;
    readonly uploadAttachment: (
      mailboxId: string,
      folderId: string,
      externalId: string,
      attachment: StoredAttachment & { readonly attachmentId: string },
      content: AsyncIterable<Uint8Array>,
    ) => Promise<Result<AppError, UploadAttachmentResult>>;
  };
  readonly imap: {
    readonly listFolders: (
      accountId: string,
    ) => Promise<Result<ImapError, readonly { path: string; specialUse: string | null }[]>>;
    readonly folderStatus: (
      accountId: string,
      path: string,
    ) => Promise<Result<ImapError, { uidValidity: number; uidNext: number; messages: number }>>;
    readonly fetchRange: (
      accountId: string,
      path: string,
      fromUid: number,
      toUid: number,
    ) => AsyncIterable<{
      readonly imapMessage: FetchedMessageLike;
      readonly bodyText: string | null;
      readonly bodyHtml: string | null;
    }>;
    readonly fetchEnvelopesRange: (
      accountId: string,
      path: string,
      fromUid: number,
      toUid: number,
    ) => AsyncIterable<FetchedMessageLike>;
    readonly downloadPart: (
      accountId: string,
      path: string,
      uid: number,
      partId: string,
    ) => Promise<{
      readonly content: AsyncIterable<Uint8Array>;
      readonly sizeBytes: number | null;
      readonly contentType: string | null;
      readonly dispose: () => void;
    }>;
  };
  readonly now: () => Date;
};

export type SyncFolderReport = {
  readonly folderId: string;
  readonly newMessages: number;
  readonly reconciledFlags: number;
  readonly uidValidityRolled: boolean;
  readonly error: string | null;
};

export type SyncReport = {
  readonly accountId: string;
  readonly folders: readonly SyncFolderReport[];
  readonly prunedFolders: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error: string | null;
};

const parseSyncState = (raw: Readonly<Record<string, unknown>> | null): SyncState | null => {
  if (raw === null) return null;
  const uv = raw.uidValidity;
  const un = raw.uidNext;
  const ls = raw.lastSyncedUid;
  if (typeof uv !== "number" || typeof un !== "number" || typeof ls !== "number") return null;
  return {
    uidValidity: uv,
    uidNext: un,
    lastSyncedUid: ls,
    lastSyncStartedAt: typeof raw.lastSyncStartedAt === "string" ? raw.lastSyncStartedAt : null,
    lastSyncFinishedAt: typeof raw.lastSyncFinishedAt === "string" ? raw.lastSyncFinishedAt : null,
    lastSyncError: typeof raw.lastSyncError === "string" ? raw.lastSyncError : null,
  };
};

const range = (lo: number, hi: number): readonly [number, number][] => {
  const out: [number, number][] = [];
  for (let from = lo; from <= hi; from += BATCH_SIZE) {
    const to = Math.min(from + BATCH_SIZE - 1, hi);
    out.push([from, to]);
  }
  return out;
};

const mergeReconciledFlags = (
  existing: StoredEmailPayload | null,
  incoming: StoredEmailPayload,
): StoredEmailPayload => {
  if (existing === null) return incoming;
  return {
    ...existing,
    flags: incoming.flags,
    labels: incoming.labels,
    fetchedAt: incoming.fetchedAt,
  };
};

/**
 * Sync one folder. Returns the per-folder report; never throws.
 * `lastSyncedUid` is advanced only after each successful batch upsert.
 */
const syncFolder = async (
  deps: SyncDeps,
  account: Account,
  mailboxId: string,
  folderPath: string,
  flagWindow: number,
): Promise<SyncFolderReport> => {
  const folderId = folderPath;
  const startIso = deps.now().toISOString();

  const statusR = await deps.imap.folderStatus(account.name, folderPath);
  if (statusR.tag === "Err") {
    return {
      folderId,
      newMessages: 0,
      reconciledFlags: 0,
      uidValidityRolled: false,
      error: errorMessage(statusR.error),
    };
  }
  const status = statusR.value;

  const existing = await deps.drive.getFolder(mailboxId, folderId);
  if (existing.tag === "Err") {
    return {
      folderId,
      newMessages: 0,
      reconciledFlags: 0,
      uidValidityRolled: false,
      error: errorMessage(existing.error),
    };
  }
  let state = parseSyncState(existing.value?.metadata ?? null);
  let uidValidityRolled = false;

  // UIDVALIDITY rollover: drop the folder and start over.
  if (state !== null && state.uidValidity !== status.uidValidity) {
    uidValidityRolled = true;
    const del = await deps.drive.deleteFolder(mailboxId, folderId);
    if (del.tag === "Err") {
      return {
        folderId,
        newMessages: 0,
        reconciledFlags: 0,
        uidValidityRolled,
        error: errorMessage(del.error),
      };
    }
    state = null;
  }

  const fromUid = (state?.lastSyncedUid ?? 0) + 1;
  const toUid = status.uidNext - 1;

  let lastSynced = state?.lastSyncedUid ?? 0;
  let newMessages = 0;

  // Initial folder upsert with fresh metadata. We rewrite metadata at
  // each successful batch so the on-disk checkpoint mirrors progress.
  const writeState = async (next: SyncState): Promise<Result<AppError, void>> =>
    deps.drive.upsertFolder(mailboxId, folderId, folderId, next);

  if (state === null) {
    const init: SyncState = {
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      lastSyncedUid: 0,
      lastSyncStartedAt: startIso,
      lastSyncFinishedAt: null,
      lastSyncError: null,
    };
    const w = await writeState(init);
    if (w.tag === "Err") {
      return {
        folderId,
        newMessages: 0,
        reconciledFlags: 0,
        uidValidityRolled,
        error: errorMessage(w.error),
      };
    }
    state = init;
  } else {
    const w = await writeState({
      ...state,
      uidNext: status.uidNext,
      lastSyncStartedAt: startIso,
      lastSyncError: null,
    });
    if (w.tag === "Err") {
      return {
        folderId,
        newMessages: 0,
        reconciledFlags: 0,
        uidValidityRolled,
        error: errorMessage(w.error),
      };
    }
  }

  if (toUid >= fromUid) {
    const finishWithError = async (error: AppError): Promise<SyncFolderReport> => {
      const w = await writeState({
        ...(state as SyncState),
        uidValidity: status.uidValidity,
        uidNext: status.uidNext,
        lastSyncedUid: lastSynced,
        lastSyncError: errorMessage(error),
        lastSyncFinishedAt: deps.now().toISOString(),
      });
      if (w.tag === "Err") {
        return {
          folderId,
          newMessages,
          reconciledFlags: 0,
          uidValidityRolled,
          error: errorMessage(w.error),
        };
      }
      return {
        folderId,
        newMessages,
        reconciledFlags: 0,
        uidValidityRolled,
        error: errorMessage(error),
      };
    };

    for (const [batchFrom, batchTo] of range(fromUid, toUid)) {
      let sawMessageInBatch = false;
      try {
        for await (const bundle of deps.imap.fetchRange(
          account.name,
          folderPath,
          batchFrom,
          batchTo,
        )) {
          sawMessageInBatch = true;
          const uid = bundle.imapMessage.uid;
          const externalId = externalIdFor(status.uidValidity, uid);
          let payload = toStoredPayload(bundle.imapMessage, {
            accountId: account.name,
            mailbox: folderPath,
            uidValidity: status.uidValidity,
            fetchedAt: deps.now(),
            bodyText: bundle.bodyText,
            bodyHtml: bundle.bodyHtml,
            truncated: false,
          });

          const initialUpsert = await deps.drive.upsertMessages(
            mailboxId,
            folderId,
            [payload],
            [externalId],
          );
          if (initialUpsert.tag === "Err") {
            return await finishWithError(initialUpsert.error);
          }

          if (payload.attachments.length === 0) {
            newMessages += initialUpsert.value.inserted + initialUpsert.value.updated;
            lastSynced = uid;
            continue;
          }

          for (const rawAttachment of payload.attachments) {
            const attachment = withAttachmentId(rawAttachment, status.uidValidity, uid);
            const downloaded = await deps.imap.downloadPart(
              account.name,
              folderPath,
              uid,
              attachment.partId,
            );
            const uploadAttachment = {
              ...attachment,
              sizeBytes: downloaded.sizeBytes ?? attachment.sizeBytes,
              contentType: downloaded.contentType ?? attachment.contentType,
            };
            const uploaded = await deps.drive.uploadAttachment(
              mailboxId,
              folderId,
              externalId,
              uploadAttachment,
              downloaded.content,
            );
            if (uploaded.tag === "Err") {
              downloaded.dispose();
              return await finishWithError(uploaded.error);
            }
            payload = patchAttachmentStorageRef(payload, attachment.attachmentId, uploaded.value);
          }

          const finalUpsert = await deps.drive.upsertMessages(
            mailboxId,
            folderId,
            [payload],
            [externalId],
          );
          if (finalUpsert.tag === "Err") {
            return await finishWithError(finalUpsert.error);
          }
          newMessages += initialUpsert.value.inserted + initialUpsert.value.updated;
          lastSynced = uid;
        }
      } catch (cause) {
        const e = imapError(account.name, `fetch UID ${batchFrom}:${batchTo}`, cause);
        return await finishWithError(e);
      }

      if (!sawMessageInBatch) {
        // Range was empty -- advance the checkpoint to the batch top
        // anyway, we now know there is nothing to fetch in there.
        lastSynced = batchTo;
      }

      // Checkpoint: write once after the batch, but the value is the
      // highest UID whose full message payload + attachment bytes are durable.
      const checkpoint: SyncState = {
        ...(state as SyncState),
        uidValidity: status.uidValidity,
        uidNext: status.uidNext,
        lastSyncedUid: lastSynced,
        lastSyncFinishedAt: deps.now().toISOString(),
        lastSyncError: null,
      };
      const w = await writeState(checkpoint);
      if (w.tag === "Err") {
        return {
          folderId,
          newMessages,
          reconciledFlags: 0,
          uidValidityRolled,
          error: errorMessage(w.error),
        };
      }
      state = checkpoint;
    }
  }

  // Sliding-window flag reconciliation. Bounds drift to flagWindow UIDs.
  let reconciledFlags = 0;
  if (flagWindow > 0 && lastSynced > 0) {
    const reconFrom = Math.max(1, lastSynced - flagWindow + 1);
    try {
      const updated: StoredEmailPayload[] = [];
      const updatedIds: string[] = [];
      for await (const env of deps.imap.fetchEnvelopesRange(
        account.name,
        folderPath,
        reconFrom,
        lastSynced,
      )) {
        const incoming = toStoredPayload(env, {
          accountId: account.name,
          mailbox: folderPath,
          uidValidity: status.uidValidity,
          fetchedAt: deps.now(),
          bodyText: null,
          bodyHtml: null,
          truncated: false,
        });
        const externalId = externalIdFor(status.uidValidity, env.uid);
        const existingPayload = await deps.drive.getMessage(mailboxId, folderId, externalId);
        if (existingPayload.tag === "Err") {
          return {
            folderId,
            newMessages,
            reconciledFlags: 0,
            uidValidityRolled,
            error: errorMessage(existingPayload.error),
          };
        }
        updated.push(mergeReconciledFlags(existingPayload.value, incoming));
        updatedIds.push(externalId);
      }
      if (updated.length > 0) {
        const ups = await deps.drive.upsertMessages(mailboxId, folderId, updated, updatedIds);
        if (ups.tag === "Err") {
          // Reconciliation is best-effort; record but don't advance error state.
          return {
            folderId,
            newMessages,
            reconciledFlags: 0,
            uidValidityRolled,
            error: errorMessage(ups.error),
          };
        }
        reconciledFlags = updated.length;
      }
    } catch (cause) {
      // Best-effort step; keep main result.
      const e = imapError(account.name, "flag reconciliation", cause);
      return {
        folderId,
        newMessages,
        reconciledFlags: 0,
        uidValidityRolled,
        error: errorMessage(e),
      };
    }
  }

  return { folderId, newMessages, reconciledFlags, uidValidityRolled, error: null };
};

/**
 * Run one sync tick for one account. Sequentially walks all folders,
 * then prunes Drive folders that no longer exist in IMAP.
 */
export const runSyncOnce = async (
  deps: SyncDeps,
  account: Account,
  watcher: WatcherSettings,
): Promise<SyncReport> => {
  const startedAt = deps.now().toISOString();
  const mailboxId = sanitizeMailboxId(account.name);
  const displayName = isOAuthAccount(account)
    ? account.email
    : (account.full_name ?? account.email);

  const ens = await deps.drive.ensureMailbox(mailboxId, displayName);
  if (ens.tag === "Err") {
    return {
      accountId: account.name,
      folders: [],
      prunedFolders: 0,
      startedAt,
      finishedAt: deps.now().toISOString(),
      error: errorMessage(ens.error),
    };
  }

  const foldersR = await deps.imap.listFolders(account.name);
  if (foldersR.tag === "Err") {
    return {
      accountId: account.name,
      folders: [],
      prunedFolders: 0,
      startedAt,
      finishedAt: deps.now().toISOString(),
      error: errorMessage(foldersR.error),
    };
  }
  const allFolders = foldersR.value;
  const filteredFolders = (() => {
    if (watcher.folders === undefined || watcher.folders.length === 0) return allFolders;
    const allow = new Set(watcher.folders);
    return allFolders.filter((f) => allow.has(f.path));
  })();

  const reports: SyncFolderReport[] = [];
  for (const f of filteredFolders) {
    const r = await syncFolder(deps, account, mailboxId, f.path, watcher.flag_reconcile_window);
    reports.push(r);
  }

  // Prune Drive folders that disappeared from IMAP.
  let prunedFolders = 0;
  const driveFoldersR = await deps.drive.listFolders(mailboxId);
  if (driveFoldersR.tag === "Ok") {
    const imapPaths = new Set(filteredFolders.map((f) => f.path));
    for (const df of driveFoldersR.value) {
      if (!imapPaths.has(df.folderId)) {
        const del = await deps.drive.deleteFolder(mailboxId, df.folderId);
        if (del.tag === "Ok") prunedFolders += 1;
      }
    }
  }

  const finishedAt = deps.now().toISOString();
  const firstError = reports.find((r) => r.error !== null)?.error ?? null;
  return {
    accountId: account.name,
    folders: reports,
    prunedFolders,
    startedAt,
    finishedAt,
    error: firstError,
  };
};

// Re-export for tests.
export const __test__ = { Err };

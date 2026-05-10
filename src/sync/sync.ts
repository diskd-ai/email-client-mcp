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
import type { UploadAttachmentResult } from "../store/attachments.js";
import { externalIdFor, sanitizeMailboxId } from "../store/conventions.js";
import type { StoredAttachment, StoredEmailPayload, SyncState } from "../store/payloadTypes.js";
import { type BodyHydrationRef, hydrateStoredMessageBodies } from "./bodyHydration.js";

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
    readonly patchMessages: (
      mailboxId: string,
      folderId: string,
      patches: readonly {
        readonly externalId: string;
        readonly payloadPatch: Readonly<Record<string, unknown>>;
      }[],
    ) => Promise<Result<AppError, { patched: number; missingExternalIds: readonly string[] }>>;
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
    readonly fetchMetadataRange: (
      accountId: string,
      path: string,
      fromUid: number,
      toUid: number,
    ) => AsyncIterable<FetchedMessageLike>;
    readonly fetchEnvelopesRange: (
      accountId: string,
      path: string,
      fromUid: number,
      toUid: number,
    ) => AsyncIterable<FetchedMessageLike>;
    readonly fetchBody: (
      accountId: string,
      mailbox: string,
      uid: number,
    ) => Promise<
      Result<
        ImapError,
        {
          readonly bodyText: string | null;
          readonly bodyHtml: string | null;
          readonly truncated: boolean;
          readonly bytesRead: number;
        } | null
      >
    >;
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
  readonly log?: (msg: string, extra?: Readonly<Record<string, unknown>>) => void;
  readonly notifier?: {
    readonly notifyEmailPersisted: (event: {
      readonly accountId: string;
      readonly mailboxId: string;
      readonly folderId: string;
      readonly externalId: string;
    }) => Promise<void>;
  };
};

export type SyncFolderReport = {
  readonly folderId: string;
  readonly newMessages: number;
  readonly forwardMessages?: number;
  readonly backfilledMessages?: number;
  readonly reconciledFlags: number;
  readonly hydratedBodies: number;
  readonly bodyHydrationErrors: number;
  readonly uidValidityRolled: boolean;
  readonly forwardSyncedUid?: number | null;
  readonly backfillBeforeUid?: number | null;
  readonly backfillComplete?: boolean;
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

type ParsedSyncState = {
  readonly state: SyncState;
  readonly source: "v2" | "legacy";
};

const parseSyncState = (raw: Readonly<Record<string, unknown>> | null): ParsedSyncState | null => {
  if (raw === null) return null;
  const uv = raw.uidValidity;
  const un = raw.uidNext;
  if (typeof uv !== "number" || typeof un !== "number") return null;

  const forward = raw.forwardSyncedUid;
  if (typeof forward === "number") {
    const backfill = raw.backfillBeforeUid;
    const lastSyncedUid = typeof raw.lastSyncedUid === "number" ? raw.lastSyncedUid : forward;
    return {
      source: "v2",
      state: {
        uidValidity: uv,
        uidNext: un,
        forwardSyncedUid: forward,
        backfillBeforeUid: typeof backfill === "number" ? backfill : null,
        lastSyncedUid,
        lastSyncStartedAt: typeof raw.lastSyncStartedAt === "string" ? raw.lastSyncStartedAt : null,
        lastSyncFinishedAt:
          typeof raw.lastSyncFinishedAt === "string" ? raw.lastSyncFinishedAt : null,
        lastSyncError: typeof raw.lastSyncError === "string" ? raw.lastSyncError : null,
      },
    };
  }

  const legacyLastSynced = raw.lastSyncedUid;
  if (typeof legacyLastSynced !== "number") return null;
  return {
    source: "legacy",
    state: {
      uidValidity: uv,
      uidNext: un,
      forwardSyncedUid: legacyLastSynced,
      backfillBeforeUid: null,
      lastSyncedUid: legacyLastSynced,
      lastSyncStartedAt: typeof raw.lastSyncStartedAt === "string" ? raw.lastSyncStartedAt : null,
      lastSyncFinishedAt:
        typeof raw.lastSyncFinishedAt === "string" ? raw.lastSyncFinishedAt : null,
      lastSyncError: typeof raw.lastSyncError === "string" ? raw.lastSyncError : null,
    },
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

const descendingRange = (lo: number, hi: number): readonly [number, number][] => {
  const out: [number, number][] = [];
  for (let to = hi; to >= lo; to -= BATCH_SIZE) {
    const from = Math.max(lo, to - BATCH_SIZE + 1);
    out.push([from, to]);
  }
  return out;
};

const reconciledFlagPatch = (incoming: StoredEmailPayload): Readonly<Record<string, unknown>> => ({
  flags: incoming.flags,
  labels: incoming.labels,
  fetchedAt: incoming.fetchedAt,
});

const isAllMailFolder = (folderPath: string, specialUse: string | null): boolean =>
  specialUse === "\\All" || /(?:^|\/)All Mail$/i.test(folderPath);

const bodyHydrationEnabledForFolder = (
  watcher: WatcherSettings,
  folderPath: string,
  specialUse: string | null,
): boolean => {
  const settings = watcher.body_hydration;
  if (settings.enabled !== true || settings.max_messages_per_tick <= 0) return false;
  if (settings.skip_all_mail && isAllMailFolder(folderPath, specialUse)) return false;
  return true;
};

const folderPriority = (folderPath: string, specialUse: string | null): number => {
  const normalized = folderPath.toLowerCase();
  if (specialUse === "\\Inbox" || normalized === "inbox") return 0;
  if (specialUse === "\\Sent" || /(?:^|\/)sent$/i.test(folderPath)) return 1;
  if (specialUse === "\\Flagged" || /(?:^|\/)(important|starred)$/i.test(folderPath)) {
    return 2;
  }
  if (isAllMailFolder(folderPath, specialUse)) return 5;
  return 4;
};

const sortFoldersByPriority = <
  T extends { readonly path: string; readonly specialUse: string | null },
>(
  folders: readonly T[],
): readonly T[] =>
  folders
    .map((folder, index) => ({ folder, index }))
    .sort((a, b) => {
      const byPriority =
        folderPriority(a.folder.path, a.folder.specialUse) -
        folderPriority(b.folder.path, b.folder.specialUse);
      if (byPriority !== 0) return byPriority;
      return a.index - b.index;
    })
    .map(({ folder }) => folder);

/**
 * Sync one folder. Returns the per-folder report; never throws.
 * `lastSyncedUid` is advanced only after each successful batch upsert.
 */
type SyncFolderOptions = {
  readonly runMaintenance: boolean;
};

const syncFolder = async (
  deps: SyncDeps,
  account: Account,
  mailboxId: string,
  folderPath: string,
  specialUse: string | null,
  watcher: WatcherSettings,
  options: SyncFolderOptions,
): Promise<SyncFolderReport> => {
  const folderId = folderPath;
  const startIso = deps.now().toISOString();
  const flagWindow = watcher.flag_reconcile_window;
  const bodyHydrationCandidates: BodyHydrationRef[] = [];
  let hydratedBodies = 0;
  let bodyHydrationErrors = 0;

  const statusR = await deps.imap.folderStatus(account.name, folderPath);
  if (statusR.tag === "Err") {
    return {
      folderId,
      newMessages: 0,
      reconciledFlags: 0,
      hydratedBodies: 0,
      bodyHydrationErrors: 0,
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
      hydratedBodies: 0,
      bodyHydrationErrors: 0,
      uidValidityRolled: false,
      error: errorMessage(existing.error),
    };
  }
  let parsedState = parseSyncState(existing.value?.metadata ?? null);
  let state = parsedState?.state ?? null;
  let uidValidityRolled = false;
  const latestUid = status.uidNext - 1;
  const recentFirst = watcher.recent_first;

  // UIDVALIDITY rollover: drop the folder and start over.
  if (state !== null && state.uidValidity !== status.uidValidity) {
    uidValidityRolled = true;
    const del = await deps.drive.deleteFolder(mailboxId, folderId);
    if (del.tag === "Err") {
      return {
        folderId,
        newMessages: 0,
        reconciledFlags: 0,
        hydratedBodies: 0,
        bodyHydrationErrors: 0,
        uidValidityRolled,
        error: errorMessage(del.error),
      };
    }
    parsedState = null;
    state = null;
  }

  let newMessages = 0;
  let forwardMessages = 0;
  let backfilledMessages = 0;

  // Initial folder upsert with fresh metadata. We rewrite metadata at
  // each successful batch so the on-disk checkpoint mirrors progress.
  const writeState = async (next: SyncState): Promise<Result<AppError, void>> =>
    deps.drive.upsertFolder(mailboxId, folderId, folderId, next);

  const recentFrom = Math.max(1, status.uidNext - recentFirst.initial_recent_window);
  const needsRecentBootstrap =
    recentFirst.enabled &&
    latestUid >= 1 &&
    (state === null || (parsedState?.source === "legacy" && state.forwardSyncedUid < latestUid));

  if (state === null) {
    const init: SyncState = {
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      forwardSyncedUid: 0,
      backfillBeforeUid: needsRecentBootstrap && recentFrom > 1 ? recentFrom : null,
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
        hydratedBodies: 0,
        bodyHydrationErrors: 0,
        uidValidityRolled,
        error: errorMessage(w.error),
      };
    }
    state = init;
  } else {
    state = {
      ...state,
      uidNext: status.uidNext,
      backfillBeforeUid:
        needsRecentBootstrap && recentFrom > 1 ? recentFrom : state.backfillBeforeUid,
      lastSyncStartedAt: startIso,
      lastSyncError: null,
    };
    const w = await writeState(state);
    if (w.tag === "Err") {
      return {
        folderId,
        newMessages: 0,
        reconciledFlags: 0,
        hydratedBodies: 0,
        bodyHydrationErrors: 0,
        uidValidityRolled,
        error: errorMessage(w.error),
      };
    }
  }

  const finishWithError = async (error: AppError): Promise<SyncFolderReport> => {
    const erroredState: SyncState = {
      ...(state as SyncState),
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      lastSyncError: errorMessage(error),
      lastSyncFinishedAt: deps.now().toISOString(),
    };
    const w = await writeState(erroredState);
    if (w.tag === "Err") {
      return {
        folderId,
        newMessages,
        forwardMessages,
        backfilledMessages,
        reconciledFlags: 0,
        hydratedBodies,
        bodyHydrationErrors,
        uidValidityRolled,
        forwardSyncedUid: state?.forwardSyncedUid ?? null,
        backfillBeforeUid: state?.backfillBeforeUid ?? null,
        backfillComplete: state?.backfillBeforeUid === null,
        error: errorMessage(w.error),
      };
    }
    state = erroredState;
    return {
      folderId,
      newMessages,
      forwardMessages,
      backfilledMessages,
      reconciledFlags: 0,
      hydratedBodies,
      bodyHydrationErrors,
      uidValidityRolled,
      forwardSyncedUid: state.forwardSyncedUid,
      backfillBeforeUid: state.backfillBeforeUid,
      backfillComplete: state.backfillBeforeUid === null,
      error: errorMessage(error),
    };
  };

  const processMetadataRanges = async (
    rangesToProcess: readonly [number, number][],
    mode: "forward" | "backfill",
    hydrateBodies: boolean,
    notifyForwardInbox: boolean,
  ): Promise<SyncFolderReport | null> => {
    for (const [batchFrom, batchTo] of rangesToProcess) {
      let sawMessageInBatch = false;
      let durableUid = mode === "forward" ? batchFrom - 1 : batchTo + 1;
      const persistedForwardInboxEvents: Array<{
        readonly accountId: string;
        readonly mailboxId: string;
        readonly folderId: string;
        readonly externalId: string;
      }> = [];
      const batchPayloads: StoredEmailPayload[] = [];
      const batchExternalIds: string[] = [];
      const batchBodyHydrationCandidates: BodyHydrationRef[] = [];
      const batchForwardInboxEvents: Array<{
        readonly accountId: string;
        readonly mailboxId: string;
        readonly folderId: string;
        readonly externalId: string;
      }> = [];
      try {
        for await (const imapMessage of deps.imap.fetchMetadataRange(
          account.name,
          folderPath,
          batchFrom,
          batchTo,
        )) {
          sawMessageInBatch = true;
          const uid = imapMessage.uid;
          const externalId = externalIdFor(status.uidValidity, uid);
          const payload = toStoredPayload(imapMessage, {
            accountId: account.name,
            mailbox: folderPath,
            uidValidity: status.uidValidity,
            fetchedAt: deps.now(),
            bodyText: null,
            bodyHtml: null,
            truncated: false,
          });

          batchPayloads.push(payload);
          batchExternalIds.push(externalId);
          if (notifyForwardInbox && mode === "forward" && folderId === "INBOX") {
            batchForwardInboxEvents.push({
              accountId: account.name,
              mailboxId,
              folderId,
              externalId,
            });
          }
          if (hydrateBodies && bodyHydrationEnabledForFolder(watcher, folderPath, specialUse)) {
            batchBodyHydrationCandidates.push({ mailboxId, folderId, externalId });
          }
          durableUid = uid;
        }
      } catch (cause) {
        const e = imapError(account.name, `fetch UID ${batchFrom}:${batchTo}`, cause);
        return await finishWithError(e);
      }

      if (!sawMessageInBatch) {
        // Range was empty -- advance the checkpoint anyway; we now know
        // there is nothing to fetch in that range.
        durableUid = mode === "forward" ? batchTo : batchFrom;
      } else {
        const upsert = await deps.drive.upsertMessages(
          mailboxId,
          folderId,
          batchPayloads,
          batchExternalIds,
        );
        if (upsert.tag === "Err") {
          return await finishWithError(upsert.error);
        }

        const changed = upsert.value.inserted + upsert.value.updated;
        newMessages += changed;
        if (mode === "forward") {
          forwardMessages += changed;
          if (changed > 0) {
            persistedForwardInboxEvents.push(...batchForwardInboxEvents);
          }
        } else backfilledMessages += changed;
        bodyHydrationCandidates.push(...batchBodyHydrationCandidates);
      }

      const checkpoint: SyncState =
        mode === "forward"
          ? {
              ...(state as SyncState),
              uidValidity: status.uidValidity,
              uidNext: status.uidNext,
              forwardSyncedUid: durableUid,
              lastSyncedUid: durableUid,
              lastSyncFinishedAt: deps.now().toISOString(),
              lastSyncError: null,
            }
          : {
              ...(state as SyncState),
              uidValidity: status.uidValidity,
              uidNext: status.uidNext,
              backfillBeforeUid: batchFrom > 1 ? batchFrom : null,
              lastSyncFinishedAt: deps.now().toISOString(),
              lastSyncError: null,
            };
      const w = await writeState(checkpoint);
      if (w.tag === "Err") {
        return {
          folderId,
          newMessages,
          forwardMessages,
          backfilledMessages,
          reconciledFlags: 0,
          hydratedBodies,
          bodyHydrationErrors,
          uidValidityRolled,
          forwardSyncedUid: state?.forwardSyncedUid ?? null,
          backfillBeforeUid: state?.backfillBeforeUid ?? null,
          backfillComplete: state?.backfillBeforeUid === null,
          error: errorMessage(w.error),
        };
      }
      state = checkpoint;

      if (deps.notifier && persistedForwardInboxEvents.length > 0) {
        for (const event of persistedForwardInboxEvents) {
          try {
            deps.log?.("signal.notify-start", event);
            await deps.notifier.notifyEmailPersisted(event);
            deps.log?.("signal.notify-ok", event);
          } catch (cause) {
            deps.log?.("signal.notify-err", {
              ...event,
              error: cause instanceof Error ? cause.message : String(cause),
            });
            // Best-effort post-checkpoint notification. app-service publishes
            // deterministic event ids, so duplicate/replayed notifications are safe.
          }
        }
      }
    }
    return null;
  };

  if (latestUid >= 1) {
    if (needsRecentBootstrap) {
      const bootstrapError = await processMetadataRanges(
        range(recentFrom, latestUid),
        "forward",
        true,
        false,
      );
      if (bootstrapError !== null) return bootstrapError;
    } else if (latestUid > state.forwardSyncedUid) {
      const forwardError = await processMetadataRanges(
        range(state.forwardSyncedUid + 1, latestUid),
        "forward",
        true,
        true,
      );
      if (forwardError !== null) return forwardError;
    }

    if (
      options.runMaintenance &&
      forwardMessages === 0 &&
      !needsRecentBootstrap &&
      recentFirst.enabled &&
      recentFirst.backfill_window_per_tick > 0 &&
      state.backfillBeforeUid !== null &&
      state.backfillBeforeUid > 1
    ) {
      const backfillTo = state.backfillBeforeUid - 1;
      const backfillFrom = Math.max(
        1,
        state.backfillBeforeUid - recentFirst.backfill_window_per_tick,
      );
      const backfillError = await processMetadataRanges(
        descendingRange(backfillFrom, backfillTo),
        "backfill",
        false,
        false,
      );
      if (backfillError !== null) return backfillError;
    }
  }

  if (bodyHydrationCandidates.length > 0) {
    const hydration = await hydrateStoredMessageBodies(
      {
        drive: deps.drive,
        imap: { fetchBody: deps.imap.fetchBody },
        now: deps.now,
      },
      bodyHydrationCandidates.slice().reverse(),
      { maxMessages: watcher.body_hydration.max_messages_per_tick },
    );
    if (hydration.tag === "Ok") {
      hydratedBodies = hydration.value.loaded.length;
      bodyHydrationErrors =
        hydration.value.failedRetryable.length + hydration.value.failedPermanent.length;
    } else {
      bodyHydrationErrors = bodyHydrationCandidates.length;
    }
  }

  // Sliding-window flag reconciliation. Bounds drift to flagWindow UIDs.
  let reconciledFlags = 0;
  if (
    options.runMaintenance &&
    forwardMessages === 0 &&
    flagWindow > 0 &&
    state.forwardSyncedUid > 0
  ) {
    const reconTo = state.forwardSyncedUid;
    const reconFrom = Math.max(1, reconTo - flagWindow + 1);
    try {
      const patches: Array<{
        readonly externalId: string;
        readonly payloadPatch: Readonly<Record<string, unknown>>;
      }> = [];
      const fallbackPayloads = new Map<string, StoredEmailPayload>();
      for await (const env of deps.imap.fetchEnvelopesRange(
        account.name,
        folderPath,
        reconFrom,
        reconTo,
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
        patches.push({ externalId, payloadPatch: reconciledFlagPatch(incoming) });
        fallbackPayloads.set(externalId, incoming);
      }
      if (patches.length > 0) {
        const patched = await deps.drive.patchMessages(mailboxId, folderId, patches);
        if (patched.tag === "Err") {
          return {
            folderId,
            newMessages,
            reconciledFlags: 0,
            hydratedBodies,
            bodyHydrationErrors,
            uidValidityRolled,
            error: errorMessage(patched.error),
          };
        }
        let fallbackChanged = 0;
        if (patched.value.missingExternalIds.length > 0) {
          const missingPayloads: StoredEmailPayload[] = [];
          const missingIds: string[] = [];
          for (const externalId of patched.value.missingExternalIds) {
            const payload = fallbackPayloads.get(externalId);
            if (payload === undefined) continue;
            missingPayloads.push(payload);
            missingIds.push(externalId);
          }
          if (missingPayloads.length > 0) {
            const ups = await deps.drive.upsertMessages(
              mailboxId,
              folderId,
              missingPayloads,
              missingIds,
            );
            if (ups.tag === "Err") {
              return {
                folderId,
                newMessages,
                reconciledFlags: 0,
                hydratedBodies,
                bodyHydrationErrors,
                uidValidityRolled,
                error: errorMessage(ups.error),
              };
            }
            fallbackChanged = ups.value.inserted + ups.value.updated;
          }
        }
        reconciledFlags = patched.value.patched + fallbackChanged;
      }
    } catch (cause) {
      // Best-effort step; keep main result.
      const e = imapError(account.name, "flag reconciliation", cause);
      return {
        folderId,
        newMessages,
        reconciledFlags: 0,
        hydratedBodies,
        bodyHydrationErrors,
        uidValidityRolled,
        error: errorMessage(e),
      };
    }
  }

  return {
    folderId,
    newMessages,
    forwardMessages,
    backfilledMessages,
    reconciledFlags,
    hydratedBodies,
    bodyHydrationErrors,
    uidValidityRolled,
    forwardSyncedUid: state.forwardSyncedUid,
    backfillBeforeUid: state.backfillBeforeUid,
    backfillComplete: state.backfillBeforeUid === null,
    error: null,
  };
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
  const filteredFolders = sortFoldersByPriority(
    (() => {
      if (watcher.folders === undefined || watcher.folders.length === 0) return allFolders;
      const allow = new Set(watcher.folders);
      return allFolders.filter((f) => allow.has(f.path));
    })(),
  );

  const maintenanceIndex =
    filteredFolders.length === 0
      ? -1
      : Math.floor(deps.now().getTime() / watcher.interval_ms) % filteredFolders.length;

  const reports: SyncFolderReport[] = [];
  for (let i = 0; i < filteredFolders.length; i += 1) {
    const f = filteredFolders[i] as (typeof filteredFolders)[number];
    const r = await syncFolder(deps, account, mailboxId, f.path, f.specialUse, watcher, {
      runMaintenance: i === maintenanceIndex,
    });
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

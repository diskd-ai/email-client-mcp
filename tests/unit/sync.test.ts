import { describe, expect, it } from "vitest";
import type { Account, WatcherSettings } from "../../src/config/schema.js";
import type { AppError, ImapError } from "../../src/domain/errors.js";
import { Err, Ok } from "../../src/domain/result.js";
import type { FetchedMessageLike } from "../../src/imap/mapper.js";
import type { StoredEmailPayload, SyncState } from "../../src/store/payloadTypes.js";
import { runSyncOnce, type SyncDeps } from "../../src/sync/sync.js";

const acct: Account = {
  name: "work",
  email: "work@example.com",
  full_name: "Work",
  password: "x",
  imap: { host: "imap.example.com", port: 993, tls: true, verify_ssl: false },
};

const watcherDefault: WatcherSettings = {
  enabled: true,
  interval_ms: 60_000,
  flag_reconcile_window: 0,
  body_hydration: {
    enabled: false,
    max_messages_per_tick: 50,
    skip_all_mail: true,
  },
  recent_first: {
    enabled: true,
    initial_recent_window: 1000,
    backfill_window_per_tick: 500,
  },
};

const watcherWithBodyHydration = (maxMessagesPerTick = 50): WatcherSettings => ({
  ...watcherDefault,
  body_hydration: {
    enabled: true,
    max_messages_per_tick: maxMessagesPerTick,
    skip_all_mail: true,
  },
});

type FakeImapState = {
  readonly folders: ReadonlyArray<{
    readonly path: string;
    readonly specialUse: string | null;
    readonly delimiter?: string;
  }>;
  readonly messagesByFolder: Map<
    string,
    {
      readonly uidValidity: number;
      readonly uidNext: number;
      readonly msgs: ReadonlyArray<FetchedMessageLike>;
    }
  >;
};

type FakeDriveState = {
  mailboxes: Map<string, { displayName: string; metadata: Readonly<Record<string, unknown>> }>;
  folders: Map<
    string,
    Map<
      string,
      {
        metadata: Record<string, unknown>;
        messageIds: Set<string>;
        payloads: Map<string, StoredEmailPayload>;
      }
    >
  >;
};

const buildFakeDeps = (
  imap: FakeImapState,
  drive: FakeDriveState,
  options?: {
    readonly upsertMessagesError?: {
      triggerOnCallNumber: number;
      message: string;
    };
    readonly uploadAttachmentError?: {
      readonly attachmentId: string;
      readonly message: string;
    };
    readonly uploadedAttachments?: Array<{
      readonly mailboxId: string;
      readonly folderId: string;
      readonly externalId: string;
      readonly attachmentId: string;
      readonly partId: string;
      readonly filename: string;
      readonly contentType: string;
      readonly sizeBytes: number;
      readonly chunks: readonly string[];
    }>;
    readonly uploadAttachmentSkipsContent?: boolean;
    readonly downloadDisposeCalls?: string[];
    readonly downloadCalls?: string[];
    readonly fetchRangeCalls?: string[];
    readonly fetchMetadataRangeCalls?: string[];
    readonly fetchEnvelopeRangeCalls?: string[];
    readonly fetchBodyCalls?: string[];
    readonly fetchBodyErrors?: ReadonlyMap<number, ImapError>;
    readonly getMessageCalls?: string[];
    readonly upsertMessagesCalls?: string[];
    readonly patchMessagesCalls?: string[];
    readonly notifyCalls?: string[];
    readonly notifyError?: Error;
    readonly syncLogs?: string[];
    readonly clock?: () => Date;
  },
): SyncDeps => {
  let upsertCalls = 0;
  return {
    drive: {
      ensureMailbox: async (mailboxId, displayName, metadata) => {
        drive.mailboxes.set(mailboxId, { displayName, metadata });
        if (!drive.folders.has(mailboxId)) drive.folders.set(mailboxId, new Map());
        return Ok(undefined);
      },
      upsertFolder: async (mailboxId, folderId, _displayName, metadata) => {
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Err({ kind: "DriveError", message: "no mailbox" } as AppError);
        const cur = m.get(folderId);
        if (cur === undefined) {
          m.set(folderId, {
            metadata: metadata as unknown as Record<string, unknown>,
            messageIds: new Set(),
            payloads: new Map(),
          });
        } else {
          cur.metadata = metadata as unknown as Record<string, unknown>;
        }
        return Ok(undefined);
      },
      getFolder: async (mailboxId, folderId) => {
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Ok(null);
        const f = m.get(folderId);
        if (f === undefined) return Ok(null);
        return Ok({ metadata: f.metadata });
      },
      listFolders: async (mailboxId) => {
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Ok([]);
        return Ok(
          Array.from(m.entries()).map(([fid, v]) => ({
            folderId: fid,
            messageCount: v.messageIds.size,
          })),
        );
      },
      deleteFolder: async (mailboxId, folderId) => {
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Ok({ deletedMessageCount: 0 });
        const f = m.get(folderId);
        const deleted = f?.messageIds.size ?? 0;
        m.delete(folderId);
        return Ok({ deletedMessageCount: deleted });
      },
      upsertMessages: async (mailboxId, folderId, payloads, externalIds) => {
        upsertCalls += 1;
        options?.upsertMessagesCalls?.push(`${mailboxId}:${folderId}:${payloads.length}`);
        if (
          options?.upsertMessagesError !== undefined &&
          options.upsertMessagesError.triggerOnCallNumber === upsertCalls
        ) {
          return Err({
            kind: "DriveError",
            message: options.upsertMessagesError.message,
          } as AppError);
        }
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Err({ kind: "DriveError", message: "no mailbox" } as AppError);
        let f = m.get(folderId);
        if (f === undefined) {
          f = { metadata: {}, messageIds: new Set(), payloads: new Map() };
          m.set(folderId, f);
        }
        let inserted = 0;
        let updated = 0;
        for (let i = 0; i < externalIds.length; i++) {
          const id = externalIds[i] as string;
          if (f.messageIds.has(id)) updated += 1;
          else {
            f.messageIds.add(id);
            inserted += 1;
          }
          f.payloads.set(id, payloads[i] as StoredEmailPayload);
        }
        return Ok({ inserted, updated });
      },
      getMessage: async (mailboxId, folderId, externalId) => {
        options?.getMessageCalls?.push(`${mailboxId}:${folderId}:${externalId}`);
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Ok(null);
        const f = m.get(folderId);
        if (f === undefined) return Ok(null);
        return Ok(f.payloads.get(externalId) ?? null);
      },
      patchMessages: async (mailboxId, folderId, patches) => {
        options?.patchMessagesCalls?.push(`${mailboxId}:${folderId}:${patches.length}`);
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Err({ kind: "DriveError", message: "no mailbox" } as AppError);
        const f = m.get(folderId);
        if (f === undefined) return Err({ kind: "DriveError", message: "no folder" } as AppError);
        const missingExternalIds: string[] = [];
        let patched = 0;
        for (const patch of patches) {
          const existing = f.payloads.get(patch.externalId);
          if (existing === undefined) {
            missingExternalIds.push(patch.externalId);
            continue;
          }
          f.payloads.set(patch.externalId, {
            ...existing,
            ...(patch.payloadPatch as Partial<StoredEmailPayload>),
          });
          patched += 1;
        }
        return Ok({ patched, missingExternalIds });
      },
      uploadAttachment: async (mailboxId, folderId, externalId, attachment, content) => {
        const mailbox = drive.folders.get(mailboxId);
        const folder = mailbox?.get(folderId);
        if (!folder?.payloads.has(externalId)) {
          return Err({
            kind: "DriveError",
            message: `message not found: ${externalId}`,
          } as AppError);
        }
        if (options?.uploadAttachmentError?.attachmentId === attachment.attachmentId) {
          return Err({
            kind: "DriveError",
            message: options.uploadAttachmentError.message,
          } as AppError);
        }
        const chunks: string[] = [];
        if (options?.uploadAttachmentSkipsContent !== true) {
          for await (const chunk of content) {
            chunks.push(Buffer.from(chunk).toString("utf8"));
          }
        }
        options?.uploadedAttachments?.push({
          mailboxId,
          folderId,
          externalId,
          attachmentId: attachment.attachmentId,
          partId: attachment.partId,
          filename: attachment.filename,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          chunks,
        });
        return Ok({
          attachmentId: attachment.attachmentId,
          storedSizeBytes: attachment.sizeBytes,
          storedAt: "2026-04-29T10:00:00.000Z",
        });
      },
    },
    imap: {
      listFolders: async () =>
        Ok(
          imap.folders.map((folder) => ({
            path: folder.path,
            specialUse: folder.specialUse,
            delimiter: folder.delimiter ?? "/",
          })),
        ),
      folderStatus: async (_acctId, path) => {
        const f = imap.messagesByFolder.get(path);
        if (f === undefined)
          return Err({
            kind: "ImapError",
            accountId: _acctId,
            message: "no folder",
          });
        return Ok({
          uidValidity: f.uidValidity,
          uidNext: f.uidNext,
          messages: f.msgs.length,
        });
      },
      fetchMetadataRange: async function* (_acctId, path, fromUid, toUid) {
        options?.fetchMetadataRangeCalls?.push(`${path}:${fromUid}:${toUid}`);
        const f = imap.messagesByFolder.get(path);
        if (f === undefined) return;
        for (const m of f.msgs) {
          if (m.uid >= fromUid && m.uid <= toUid) yield m;
        }
      },
      fetchEnvelopesRange: async function* (_acctId, path, fromUid, toUid) {
        options?.fetchEnvelopeRangeCalls?.push(`${path}:${fromUid}:${toUid}`);
        const f = imap.messagesByFolder.get(path);
        if (f === undefined) return;
        for (const m of f.msgs) {
          if (m.uid >= fromUid && m.uid <= toUid) yield m;
        }
      },
      fetchBody: async (accountId, path, uid) => {
        options?.fetchBodyCalls?.push(`${accountId}:${path}:${uid}`);
        const error = options?.fetchBodyErrors?.get(uid);
        if (error !== undefined) return Err(error);
        return Ok({
          bodyText: `body-${uid}`,
          bodyHtml: null,
          truncated: false,
          bytesRead: Buffer.byteLength(`body-${uid}`, "utf8"),
        });
      },
      downloadPart: async (_accountId, _path, uid, partId) => {
        options?.downloadCalls?.push(`${uid}:${partId}`);
        return {
          content: (async function* (): AsyncIterable<Uint8Array> {
            yield Buffer.from(`uid-${uid}`);
            yield Buffer.from(`-part-${partId}`);
          })(),
          sizeBytes: 12,
          contentType: null,
          dispose: () => {
            options?.downloadDisposeCalls?.push(`${uid}:${partId}`);
          },
        };
      },
    },
    now: options?.clock ?? (() => new Date("2026-04-29T10:00:00.000Z")),
    log: options?.syncLogs
      ? (msg, extra) => {
          options.syncLogs?.push(`${msg}:${JSON.stringify(extra ?? {})}`);
        }
      : undefined,
    notifier: options?.notifyCalls
      ? {
          notifyEmailPersisted: async (event) => {
            options.notifyCalls?.push(
              `${event.accountId}:${event.mailboxId}:${event.folderId}:${event.externalId}`,
            );
            if (options.notifyError) throw options.notifyError;
          },
        }
      : undefined,
  };
};

const mkMsg = (uid: number): FetchedMessageLike => ({
  uid,
  flags: new Set(["\\Seen"]),
  envelope: {
    subject: `s${uid}`,
    messageId: `<${uid}@x>`,
    from: [{ address: "a@b" }],
    to: [{ address: "c@d" }],
  },
});

const mkMsgWithAttachment = (uid: number, partId = "2", sizeBytes = 12): FetchedMessageLike => ({
  ...mkMsg(uid),
  bodyStructure: {
    type: "multipart/mixed",
    childNodes: [
      {
        type: "application/pdf",
        part: partId,
        disposition: "attachment",
        dispositionParameters: { filename: `file-${uid}.pdf` },
        size: sizeBytes,
      },
    ],
  },
});

describe("sync/runSyncOnce", () => {
  it("persists the real email separately from the human account label", async () => {
    /* REQ-3066-004: IMAP sync must preserve explicit email metadata without parsing displayName. */
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = { folders: [], messagesByFolder: new Map() };

    const report = await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);

    expect(report.error).toBeNull();
    expect(drive.mailboxes.get("exchange-work")).toEqual({
      displayName: "Work",
      metadata: { email: "work@example.com" },
    });
  });

  /* REQ-2910-009: IMAP sync persists the provider hierarchy delimiter with every folder checkpoint. */
  it("persists the provider folder delimiter in messagesStore metadata", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "Aix.Conservatory", specialUse: null, delimiter: "." }],
      messagesByFolder: new Map([["Aix.Conservatory", { uidValidity: 100, uidNext: 1, msgs: [] }]]),
    };

    const report = await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);

    expect(report.error).toBeNull();
    expect(drive.folders.get("exchange-work")?.get("Aix.Conservatory")?.metadata.delimiter).toBe(
      ".",
    );
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- syncs new UIDs to messagesStore on a fresh folder */
  it("upserts all new messages on a fresh folder", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const upsertMessagesCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        [
          "INBOX",
          {
            uidValidity: 100,
            uidNext: 4,
            msgs: [mkMsg(1), mkMsg(2), mkMsg(3)],
          },
        ],
      ]),
    };
    const deps = buildFakeDeps(imap, drive, { upsertMessagesCalls });
    const rep = await runSyncOnce(deps, acct, watcherDefault);
    expect(rep.error).toBeNull();
    expect(rep.folders).toHaveLength(1);
    expect(rep.folders[0]?.newMessages).toBe(3);
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect(upsertMessagesCalls).toEqual(["exchange-work:INBOX:3"]);
    expect(stored?.messageIds.size).toBe(3);
    expect(stored?.messageIds.has("100:1")).toBe(true);
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(3);
  });

  it("notifies app-service only after post-bootstrap forward INBOX messages are stored and checkpointed", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const notifyCalls: string[] = [];
    const syncLogs: string[] = [];
    const imap1: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: "\\Inbox" }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 100, uidNext: 3, msgs: [mkMsg(1), mkMsg(2)] }],
      ]),
    };

    const bootstrap = await runSyncOnce(
      buildFakeDeps(imap1, drive, { notifyCalls, syncLogs }),
      acct,
      watcherDefault,
    );

    expect(bootstrap.error).toBeNull();
    expect(notifyCalls).toEqual([]);
    expect(syncLogs).toEqual([]);

    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: "\\Inbox" }],
      messagesByFolder: new Map([
        [
          "INBOX",
          {
            uidValidity: 100,
            uidNext: 5,
            msgs: [mkMsg(1), mkMsg(2), mkMsg(3), mkMsg(4)],
          },
        ],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap2, drive, { notifyCalls, syncLogs }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(notifyCalls).toEqual([
      "work:exchange-work:INBOX:100:3",
      "work:exchange-work:INBOX:100:4",
    ]);
    expect(syncLogs).toEqual([
      'signal.notify-start:{"accountId":"work","mailboxId":"exchange-work","folderId":"INBOX","externalId":"100:3"}',
      'signal.notify-ok:{"accountId":"work","mailboxId":"exchange-work","folderId":"INBOX","externalId":"100:3"}',
      'signal.notify-start:{"accountId":"work","mailboxId":"exchange-work","folderId":"INBOX","externalId":"100:4"}',
      'signal.notify-ok:{"accountId":"work","mailboxId":"exchange-work","folderId":"INBOX","externalId":"100:4"}',
    ]);
    const state = drive.folders.get("exchange-work")?.get("INBOX")
      ?.metadata as unknown as SyncState;
    expect(state.forwardSyncedUid).toBe(4);
  });

  it("does not notify when checkpoint write fails", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const notifyCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: "\\Inbox" }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 100, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };
    const deps = buildFakeDeps(imap, drive, { notifyCalls });
    const originalUpsertFolder = deps.drive.upsertFolder;
    let upsertFolderCalls = 0;
    deps.drive.upsertFolder = async (...args) => {
      upsertFolderCalls += 1;
      if (upsertFolderCalls === 2) {
        return Err({
          kind: "DriveError",
          message: "checkpoint failed",
        } as AppError);
      }
      return originalUpsertFolder(...args);
    };

    const rep = await runSyncOnce(deps, acct, watcherDefault);

    expect(rep.folders[0]?.error).toContain("checkpoint failed");
    expect(notifyCalls).toEqual([]);
  });

  it("does not fail sync when notification fails", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const notifyCalls: string[] = [];
    const syncLogs: string[] = [];
    const imap1: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: "\\Inbox" }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 100, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };
    await runSyncOnce(buildFakeDeps(imap1, drive), acct, watcherDefault);

    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: "\\Inbox" }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 100, uidNext: 3, msgs: [mkMsg(1), mkMsg(2)] }],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap2, drive, {
        notifyCalls,
        notifyError: new Error("notify down"),
        syncLogs,
      }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.error).toBeNull();
    expect(notifyCalls).toEqual(["work:exchange-work:INBOX:100:2"]);
    expect(syncLogs).toEqual([
      'signal.notify-start:{"accountId":"work","mailboxId":"exchange-work","folderId":"INBOX","externalId":"100:2"}',
      'signal.notify-err:{"accountId":"work","mailboxId":"exchange-work","folderId":"INBOX","externalId":"100:2","error":"notify down"}',
    ]);
  });

  it("does not notify for historical backfill or non-INBOX folders", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const notifyCalls: string[] = [];
    const messages = Array.from({ length: 10 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [
        { path: "INBOX", specialUse: "\\Inbox" },
        { path: "Sent", specialUse: "\\Sent" },
      ],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 100, uidNext: 11, msgs: messages }],
        ["Sent", { uidValidity: 100, uidNext: 2, msgs: [mkMsg(1)] }],
      ]),
    };
    const watcher: WatcherSettings = {
      ...watcherDefault,
      recent_first: {
        enabled: true,
        initial_recent_window: 2,
        backfill_window_per_tick: 2,
      },
    };

    await runSyncOnce(buildFakeDeps(imap, drive, { notifyCalls }), acct, watcher);
    expect(notifyCalls).toEqual([]);
    await runSyncOnce(buildFakeDeps(imap, drive, { notifyCalls }), acct, watcher);

    expect(notifyCalls).toEqual([]);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- recent-first initial sync indexes latest UID window before historical archive */
  it("indexes the recent UID window first for a fresh large folder", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const fetchMetadataRangeCalls: string[] = [];
    const messages = Array.from({ length: 10_000 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 77, uidNext: 10_001, msgs: messages }]]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchMetadataRangeCalls }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]).toMatchObject({
      forwardMessages: 1000,
      backfilledMessages: 0,
      forwardSyncedUid: 10_000,
      backfillBeforeUid: 9001,
      backfillComplete: false,
    });
    expect(fetchMetadataRangeCalls[0]).toBe("INBOX:9001:9050");
    expect(fetchMetadataRangeCalls).not.toContain("INBOX:1:50");
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect(stored?.messageIds.size).toBe(1000);
    expect(stored?.messageIds.has("77:10000")).toBe(true);
    expect(stored?.messageIds.has("77:1")).toBe(false);
    const state = stored?.metadata as unknown as SyncState;
    expect(state.forwardSyncedUid).toBe(10_000);
    expect(state.backfillBeforeUid).toBe(9001);
    expect(state.lastSyncedUid).toBe(10_000);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- historical backfill proceeds backwards in bounded windows */
  it("backfills historical messages on the next tick after recent-first init", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const messages = Array.from({ length: 10_000 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 77, uidNext: 10_001, msgs: messages }]]),
    };
    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);
    const fetchMetadataRangeCalls: string[] = [];

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchMetadataRangeCalls }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]).toMatchObject({
      forwardMessages: 0,
      backfilledMessages: 500,
      forwardSyncedUid: 10_000,
      backfillBeforeUid: 8501,
      backfillComplete: false,
    });
    expect(fetchMetadataRangeCalls[0]).toBe("INBOX:8951:9000");
    expect(fetchMetadataRangeCalls).not.toContain("INBOX:1:50");
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect(stored?.messageIds.has("77:8501")).toBe(true);
    expect(stored?.messageIds.has("77:1")).toBe(false);
    const state = stored?.metadata as unknown as SyncState;
    expect(state.forwardSyncedUid).toBe(10_000);
    expect(state.backfillBeforeUid).toBe(8501);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- new forward mail is indexed before historical backfill */
  it("indexes new forward mail and defers historical backfill to a later tick", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const firstMessages = Array.from({ length: 10_000 }, (_, i) => mkMsg(i + 1));
    const imap1: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 77, uidNext: 10_001, msgs: firstMessages }],
      ]),
    };
    await runSyncOnce(buildFakeDeps(imap1, drive), acct, watcherDefault);

    const nextMessages = [...firstMessages, mkMsg(10_001), mkMsg(10_002)];
    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 77, uidNext: 10_003, msgs: nextMessages }],
      ]),
    };
    const fetchMetadataRangeCalls: string[] = [];
    const rep = await runSyncOnce(
      buildFakeDeps(imap2, drive, { fetchMetadataRangeCalls }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(fetchMetadataRangeCalls).toEqual(["INBOX:10001:10002"]);
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    const state = stored?.metadata as unknown as SyncState;
    expect(state.forwardSyncedUid).toBe(10_002);
    expect(state.backfillBeforeUid).toBe(9001);

    fetchMetadataRangeCalls.length = 0;
    await runSyncOnce(
      buildFakeDeps(imap2, drive, { fetchMetadataRangeCalls }),
      acct,
      watcherDefault,
    );
    expect(fetchMetadataRangeCalls[0]).toBe("INBOX:8951:9000");
    expect(fetchMetadataRangeCalls.at(-1)).toBe("INBOX:8501:8550");
    const nextState = stored?.metadata as unknown as SyncState;
    expect(nextState.backfillBeforeUid).toBe(8501);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- partial legacy lastSyncedUid state migrates to recent-first instead of continuing old-first */
  it("migrates partial legacy sync state to recent-first", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    drive.mailboxes.set("exchange-work", { displayName: "Work", metadata: {} });
    drive.folders.set(
      "exchange-work",
      new Map([
        [
          "INBOX",
          {
            metadata: {
              uidValidity: 77,
              uidNext: 10_001,
              lastSyncedUid: 22,
              lastSyncStartedAt: "2026-04-29T09:00:00.000Z",
              lastSyncFinishedAt: null,
              lastSyncError: null,
            },
            messageIds: new Set(Array.from({ length: 22 }, (_, i) => `77:${i + 1}`)),
            payloads: new Map(),
          },
        ],
      ]),
    );
    const messages = Array.from({ length: 10_000 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 77, uidNext: 10_001, msgs: messages }]]),
    };
    const fetchMetadataRangeCalls: string[] = [];

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchMetadataRangeCalls }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(fetchMetadataRangeCalls[0]).toBe("INBOX:9001:9050");
    expect(fetchMetadataRangeCalls).not.toContain("INBOX:23:72");
    const state = drive.folders.get("exchange-work")?.get("INBOX")
      ?.metadata as unknown as SyncState;
    expect(state.forwardSyncedUid).toBe(10_000);
    expect(state.backfillBeforeUid).toBe(9001);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- folder priority syncs INBOX and Sent before archives and Gmail All Mail */
  it("syncs folders by product priority", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [
        { path: "Archive", specialUse: null },
        { path: "[Gmail]/All Mail", specialUse: "\\All" },
        { path: "Sent", specialUse: "\\Sent" },
        { path: "INBOX", specialUse: "\\Inbox" },
      ],
      messagesByFolder: new Map([
        ["Archive", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }],
        ["[Gmail]/All Mail", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }],
        ["Sent", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }],
        ["INBOX", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }],
      ]),
    };

    const rep = await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);

    expect(rep.error).toBeNull();
    expect(rep.folders.map((folder) => folder.folderId)).toEqual([
      "INBOX",
      "Sent",
      "Archive",
      "[Gmail]/All Mail",
    ]);
  });

  it("limits historical backfill and flag reconciliation to one maintenance folder per tick", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const inboxMessages = Array.from({ length: 20 }, (_, i) => mkMsg(i + 1));
    const archiveMessages = Array.from({ length: 20 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [
        { path: "Archive", specialUse: null },
        { path: "INBOX", specialUse: "\\Inbox" },
      ],
      messagesByFolder: new Map([
        ["Archive", { uidValidity: 10, uidNext: 21, msgs: archiveMessages }],
        ["INBOX", { uidValidity: 10, uidNext: 21, msgs: inboxMessages }],
      ]),
    };
    const watcher: WatcherSettings = {
      ...watcherDefault,
      flag_reconcile_window: 5,
      recent_first: {
        enabled: true,
        initial_recent_window: 2,
        backfill_window_per_tick: 2,
      },
    };

    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcher);

    const fetchMetadataRangeCalls: string[] = [];
    const fetchEnvelopeRangeCalls: string[] = [];
    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, {
        fetchMetadataRangeCalls,
        fetchEnvelopeRangeCalls,
      }),
      acct,
      watcher,
    );

    expect(rep.error).toBeNull();
    expect(fetchMetadataRangeCalls).toEqual(["INBOX:17:18"]);
    expect(fetchEnvelopeRangeCalls).toEqual(["INBOX:16:20"]);
    expect(rep.folders.find((folder) => folder.folderId === "Archive")?.backfilledMessages).toBe(0);
    expect(rep.folders.find((folder) => folder.folderId === "Archive")?.reconciledFlags).toBe(0);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- watcher indexes attachment metadata without downloading/uploading bytes */
  it("indexes attachment metadata without opening attachment streams", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const uploadedAttachments: NonNullable<
      Parameters<typeof buildFakeDeps>[2]
    >["uploadedAttachments"] = [];
    const downloadCalls: string[] = [];
    const fetchMetadataRangeCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 14, uidNext: 95, msgs: [mkMsgWithAttachment(94)] }],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, {
        uploadedAttachments,
        downloadCalls,
        fetchMetadataRangeCalls,
      }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(fetchMetadataRangeCalls).toEqual(["INBOX:1:50", "INBOX:51:94"]);
    expect(downloadCalls).toEqual([]);
    expect(uploadedAttachments).toEqual([]);
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    const payload = stored?.payloads.get("14:94");
    expect(payload?.bodyState).toBe("not_loaded");
    expect(payload?.bodyText).toBeNull();
    expect(payload?.bodyHtml).toBeNull();
    expect(payload?.attachments[0]).toMatchObject({
      attachmentId: "14:94:2",
      filename: "file-94.pdf",
      contentType: "application/pdf",
      sizeBytes: 12,
      partId: "2",
      storageState: "not_loaded",
    });
    expect(payload?.attachments[0]).not.toHaveProperty("storedAt");
    expect(payload?.attachments[0]).not.toHaveProperty("driveInode");
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(94);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- eager body hydration runs after metadata checkpoint for current-tick messages */
  it("hydrates newly indexed message bodies without blocking checkpoint", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const fetchBodyCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 14, uidNext: 3, msgs: [mkMsg(1), mkMsg(2)] }],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchBodyCalls }),
      acct,
      watcherWithBodyHydration(),
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.hydratedBodies).toBe(2);
    expect(rep.folders[0]?.bodyHydrationErrors).toBe(0);
    expect(fetchBodyCalls).toEqual(["work:INBOX:2", "work:INBOX:1"]);
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(2);
    expect(stored?.payloads.get("14:1")?.bodyState).toBe("loaded");
    expect(stored?.payloads.get("14:1")?.bodyText).toBe("body-1");
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- retryable body hydration failures do not fail metadata sync */
  it("records throttled body hydration as retryable without failing folder sync", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 14, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, {
        fetchBodyErrors: new Map([
          [
            1,
            {
              kind: "ImapError",
              accountId: "work",
              message: "Some messages could not be FETCHed (Failure) [THROTTLED]",
            },
          ],
        ]),
      }),
      acct,
      watcherWithBodyHydration(),
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.newMessages).toBe(1);
    expect(rep.folders[0]?.hydratedBodies).toBe(0);
    expect(rep.folders[0]?.bodyHydrationErrors).toBe(1);
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(1);
    expect(stored?.payloads.get("14:1")?.bodyState).toBe("failed_retryable");
    expect(stored?.payloads.get("14:1")?.bodyFetchError).toContain("THROTTLED");
  });

  it("does not hydrate bodies when eager body hydration is disabled", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const fetchBodyCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 14, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchBodyCalls }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(fetchBodyCalls).toEqual([]);
    expect(rep.folders[0]?.hydratedBodies).toBe(0);
    expect(drive.folders.get("exchange-work")?.get("INBOX")?.payloads.get("14:1")?.bodyState).toBe(
      "not_loaded",
    );
  });

  it("enforces max body hydration messages per tick", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const fetchBodyCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        [
          "INBOX",
          {
            uidValidity: 14,
            uidNext: 6,
            msgs: [mkMsg(1), mkMsg(2), mkMsg(3), mkMsg(4), mkMsg(5)],
          },
        ],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchBodyCalls }),
      acct,
      watcherWithBodyHydration(2),
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.newMessages).toBe(5);
    expect(rep.folders[0]?.hydratedBodies).toBe(2);
    expect(fetchBodyCalls).toEqual(["work:INBOX:5", "work:INBOX:4"]);
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(5);
    expect(stored?.payloads.get("14:3")?.bodyState).toBe("not_loaded");
  });

  it("skips eager body hydration for All Mail folders", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const fetchBodyCalls: string[] = [];
    const imap: FakeImapState = {
      folders: [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
      messagesByFolder: new Map([
        ["[Gmail]/All Mail", { uidValidity: 14, uidNext: 2, msgs: [mkMsg(1)] }],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { fetchBodyCalls }),
      acct,
      watcherWithBodyHydration(),
    );

    expect(rep.error).toBeNull();
    expect(fetchBodyCalls).toEqual([]);
    expect(rep.folders[0]?.newMessages).toBe(1);
    expect(rep.folders[0]?.hydratedBodies).toBe(0);
    expect(
      drive.folders.get("exchange-work")?.get("[Gmail]/All Mail")?.payloads.get("14:1")?.bodyState,
    ).toBe("not_loaded");
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- lastSyncedUid does not advance when upsertBatch fails (next tick replays) */
  it("does not advance checkpoint when upsertBatch fails", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const messages = Array.from({ length: 75 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 1, uidNext: 76, msgs: messages }]]),
    };
    // Fail on the second Drive batch (after 50 messages succeed).
    const deps = buildFakeDeps(imap, drive, {
      upsertMessagesError: { triggerOnCallNumber: 2, message: "drive 503" },
    });
    const rep = await runSyncOnce(deps, acct, watcherDefault);
    expect(rep.error).toContain("drive 503");
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect(stored?.messageIds.size).toBe(50);
    // Checkpoint reflects the last successful batch only.
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(50);

    // Second tick replays from UID 51. Drop the failure flag.
    const deps2 = buildFakeDeps(imap, drive);
    const rep2 = await runSyncOnce(deps2, acct, watcherDefault);
    expect(rep2.error).toBeNull();
    const after = drive.folders.get("exchange-work")?.get("INBOX");
    expect(after?.messageIds.size).toBe(75);
    expect((after?.metadata as unknown as SyncState).lastSyncedUid).toBe(75);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- UIDVALIDITY rollover drops the folder and resyncs from UID 1 */
  it("drops and resyncs on UIDVALIDITY rollover", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    // First tick at UIDVALIDITY=100
    const imap1: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 100, uidNext: 3, msgs: [mkMsg(1), mkMsg(2)] }],
      ]),
    };
    await runSyncOnce(buildFakeDeps(imap1, drive), acct, watcherDefault);
    const before = drive.folders.get("exchange-work")?.get("INBOX");
    expect(before?.messageIds.has("100:1")).toBe(true);

    // Second tick at UIDVALIDITY=200 (rollover).
    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 200, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap2, drive), acct, watcherDefault);
    expect(rep.folders[0]?.uidValidityRolled).toBe(true);
    const after = drive.folders.get("exchange-work")?.get("INBOX");
    expect(after?.messageIds.has("100:1")).toBe(false);
    expect(after?.messageIds.has("200:1")).toBe(true);
    expect((after?.metadata as unknown as SyncState).uidValidity).toBe(200);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- restart resumes from folder metadata, not in-memory state */
  it("resumes from folder metadata after restart (fresh deps)", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 1, uidNext: 4, msgs: [mkMsg(1), mkMsg(2), mkMsg(3)] }],
      ]),
    };
    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);
    // Add UID 4. Run with completely fresh deps -- mimics process restart.
    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        [
          "INBOX",
          {
            uidValidity: 1,
            uidNext: 5,
            msgs: [mkMsg(1), mkMsg(2), mkMsg(3), mkMsg(4)],
          },
        ],
      ]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap2, drive), acct, watcherDefault);
    expect(rep.folders[0]?.newMessages).toBe(1); // only UID 4 fetched
    const stored = drive.folders.get("exchange-work")?.get("INBOX");
    expect(stored?.messageIds.size).toBe(4);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- flag reconciliation preserves metadata-only body state */
  it("preserves unloaded body state when reconciling flags in a maintenance tick", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 14, uidNext: 95, msgs: [mkMsg(94)] }]]),
    };
    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);

    const getMessageCalls: string[] = [];
    const patchMessagesCalls: string[] = [];
    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { getMessageCalls, patchMessagesCalls }),
      acct,
      {
        ...watcherDefault,
        flag_reconcile_window: 100,
      },
    );

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.reconciledFlags).toBe(1);
    expect(getMessageCalls).toEqual([]);
    expect(patchMessagesCalls).toEqual(["exchange-work:INBOX:1"]);
    const stored = drive.folders.get("exchange-work")?.get("INBOX")?.payloads.get("14:94");
    expect(stored?.bodyState).toBe("not_loaded");
    expect(stored?.bodyText).toBeNull();
    expect(stored?.bodyHtml).toBeNull();
    expect(stored?.snippet).toBe("");
  });

  it("falls back to metadata upsert when flag reconciliation patch misses a row", async () => {
    const drive: FakeDriveState = {
      mailboxes: new Map([["exchange-work", { displayName: "Work", metadata: {} }]]),
      folders: new Map([
        [
          "exchange-work",
          new Map([
            [
              "INBOX",
              {
                metadata: {
                  uidValidity: 14,
                  uidNext: 95,
                  forwardSyncedUid: 94,
                  backfillBeforeUid: null,
                  lastSyncedUid: 94,
                  lastSyncStartedAt: null,
                  lastSyncFinishedAt: null,
                  lastSyncError: null,
                },
                messageIds: new Set(),
                payloads: new Map(),
              },
            ],
          ]),
        ],
      ]),
    };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 14, uidNext: 95, msgs: [mkMsg(94)] }]]),
    };
    const getMessageCalls: string[] = [];

    const rep = await runSyncOnce(buildFakeDeps(imap, drive, { getMessageCalls }), acct, {
      ...watcherDefault,
      flag_reconcile_window: 100,
    });

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.reconciledFlags).toBe(1);
    expect(getMessageCalls).toEqual([]);
    expect(drive.folders.get("exchange-work")?.get("INBOX")?.payloads.has("14:94")).toBe(true);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- folders deleted on IMAP are pruned from drive */
  it("prunes drive folders that disappeared from IMAP", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    // First tick: INBOX + Archive both present.
    const imap1: FakeImapState = {
      folders: [
        { path: "INBOX", specialUse: null },
        { path: "Archive", specialUse: null },
      ],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }],
        ["Archive", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }],
      ]),
    };
    await runSyncOnce(buildFakeDeps(imap1, drive), acct, watcherDefault);
    expect(drive.folders.get("exchange-work")?.has("Archive")).toBe(true);

    // Second tick: Archive is gone.
    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap2, drive), acct, watcherDefault);
    expect(rep.prunedFolders).toBe(1);
    expect(drive.folders.get("exchange-work")?.has("Archive")).toBe(false);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync-review-retention -- Review messages disappear only after explicit delete or send */
  it("preserves the platform-managed Review folder when absent from IMAP", async () => {
    const drive: FakeDriveState = {
      mailboxes: new Map([["exchange-work", { displayName: "Work", metadata: {} }]]),
      folders: new Map([
        [
          "exchange-work",
          new Map([
            [
              "Review",
              {
                metadata: {},
                messageIds: new Set(["review-1"]),
                payloads: new Map(),
              },
            ],
          ]),
        ],
      ]),
    };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };

    const rep = await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);

    expect(rep.prunedFolders).toBe(0);
    expect(drive.folders.get("exchange-work")?.has("Review")).toBe(true);
  });
});

describe("sync watcher invariants surfaced via runSyncOnce", () => {
  /* REQUIREMENT end:comm/email-client-mcp/sync -- ensureMailbox is idempotent across multiple ticks */
  it("does not duplicate mailboxes across repeated ticks", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 1, uidNext: 1, msgs: [] }]]),
    };
    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);
    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);
    await runSyncOnce(buildFakeDeps(imap, drive), acct, watcherDefault);
    expect(drive.mailboxes.size).toBe(1);
  });
});

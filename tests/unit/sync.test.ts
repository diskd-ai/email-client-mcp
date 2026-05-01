import { describe, expect, it } from "vitest";
import type { Account, WatcherSettings } from "../../src/config/schema.js";
import type { AppError, ImapError } from "../../src/domain/errors.js";
import { Err, Ok, type Result } from "../../src/domain/result.js";
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
};

type FakeImapState = {
  readonly folders: ReadonlyArray<{ readonly path: string; readonly specialUse: string | null }>;
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
  mailboxes: Map<string, { displayName: string }>;
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
    readonly upsertMessagesError?: { triggerOnCallNumber: number; message: string };
    readonly uploadAttachmentError?: { readonly attachmentId: string; readonly message: string };
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
    readonly clock?: () => Date;
  },
): SyncDeps => {
  let upsertCalls = 0;
  return {
    drive: {
      ensureMailbox: async (mailboxId, displayName) => {
        if (!drive.mailboxes.has(mailboxId)) drive.mailboxes.set(mailboxId, { displayName });
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
        const m = drive.folders.get(mailboxId);
        if (m === undefined) return Ok(null);
        const f = m.get(folderId);
        if (f === undefined) return Ok(null);
        return Ok(f.payloads.get(externalId) ?? null);
      },
      uploadAttachment: async (mailboxId, folderId, externalId, attachment, content) => {
        if (options?.uploadAttachmentError?.attachmentId === attachment.attachmentId) {
          return Err({
            kind: "DriveError",
            message: options.uploadAttachmentError.message,
          } as AppError);
        }
        const chunks: string[] = [];
        for await (const chunk of content) {
          chunks.push(Buffer.from(chunk).toString("utf8"));
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
          driveInode: `inode-${attachment.attachmentId}`,
          storedSizeBytes: attachment.sizeBytes,
          storedAt: "2026-04-29T10:00:00.000Z",
        });
      },
    },
    imap: {
      listFolders: async () =>
        Ok(imap.folders) as unknown as Result<
          ImapError,
          readonly { path: string; specialUse: string | null }[]
        >,
      folderStatus: async (_acctId, path) => {
        const f = imap.messagesByFolder.get(path);
        if (f === undefined)
          return Err({ kind: "ImapError", accountId: _acctId, message: "no folder" });
        return Ok({ uidValidity: f.uidValidity, uidNext: f.uidNext, messages: f.msgs.length });
      },
      fetchRange: async function* (_acctId, path, fromUid, toUid) {
        const f = imap.messagesByFolder.get(path);
        if (f === undefined) return;
        for (const m of f.msgs) {
          if (m.uid >= fromUid && m.uid <= toUid) {
            yield {
              imapMessage: m,
              bodyText: "body",
              bodyHtml: null,
            };
          }
        }
      },
      fetchEnvelopesRange: async function* (_acctId, path, fromUid, toUid) {
        const f = imap.messagesByFolder.get(path);
        if (f === undefined) return;
        for (const m of f.msgs) {
          if (m.uid >= fromUid && m.uid <= toUid) yield m;
        }
      },
      downloadPart: async function* (_accountId, _path, uid, partId) {
        yield Buffer.from(`uid-${uid}`);
        yield Buffer.from(`-part-${partId}`);
      },
    },
    now: options?.clock ?? (() => new Date("2026-04-29T10:00:00.000Z")),
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
  /* REQUIREMENT end:comm/email-client-mcp/sync -- syncs new UIDs to messagesStore on a fresh folder */
  it("upserts all new messages on a fresh folder", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 100, uidNext: 4, msgs: [mkMsg(1), mkMsg(2), mkMsg(3)] }],
      ]),
    };
    const deps = buildFakeDeps(imap, drive);
    const rep = await runSyncOnce(deps, acct, watcherDefault);
    expect(rep.error).toBeNull();
    expect(rep.folders).toHaveLength(1);
    expect(rep.folders[0]?.newMessages).toBe(3);
    const stored = drive.folders.get("work")?.get("INBOX");
    expect(stored?.messageIds.size).toBe(3);
    expect(stored?.messageIds.has("100:1")).toBe(true);
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(3);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- stores attachment bytes before checkpointing a message */
  it("uploads attachment streams and patches payload refs before advancing checkpoint", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const uploadedAttachments: NonNullable<
      Parameters<typeof buildFakeDeps>[2]
    >["uploadedAttachments"] = [];
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        ["INBOX", { uidValidity: 14, uidNext: 95, msgs: [mkMsgWithAttachment(94)] }],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, { uploadedAttachments }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toBeNull();
    expect(uploadedAttachments).toEqual([
      {
        mailboxId: "work",
        folderId: "INBOX",
        externalId: "14:94",
        attachmentId: "14:94:2",
        partId: "2",
        filename: "file-94.pdf",
        contentType: "application/pdf",
        sizeBytes: 12,
        chunks: ["uid-94", "-part-2"],
      },
    ]);
    const stored = drive.folders.get("work")?.get("INBOX");
    const payload = stored?.payloads.get("14:94");
    expect(payload?.attachments[0]).toMatchObject({
      attachmentId: "14:94:2",
      driveInode: "inode-14:94:2",
      storedSizeBytes: 12,
      storedAt: "2026-04-29T10:00:00.000Z",
    });
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(94);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- attachment upload failure blocks checkpoint advancement for that UID */
  it("does not checkpoint a UID whose attachment upload fails", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([
        [
          "INBOX",
          {
            uidValidity: 14,
            uidNext: 97,
            msgs: [mkMsg(94), mkMsgWithAttachment(95), mkMsgWithAttachment(96)],
          },
        ],
      ]),
    };

    const rep = await runSyncOnce(
      buildFakeDeps(imap, drive, {
        uploadAttachmentError: { attachmentId: "14:96:2", message: "upload failed" },
      }),
      acct,
      watcherDefault,
    );

    expect(rep.error).toContain("upload failed");
    const stored = drive.folders.get("work")?.get("INBOX");
    expect(stored?.messageIds.has("14:94")).toBe(true);
    expect(stored?.messageIds.has("14:95")).toBe(true);
    expect(stored?.messageIds.has("14:96")).toBe(false);
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(95);
    expect((stored?.metadata as unknown as SyncState).lastSyncError).toContain("upload failed");
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- lastSyncedUid does not advance when upsertBatch fails (next tick replays) */
  it("does not advance checkpoint when upsertBatch fails", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const messages = Array.from({ length: 75 }, (_, i) => mkMsg(i + 1));
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 1, uidNext: 76, msgs: messages }]]),
    };
    // Fail on UID 51 (after 50 messages succeed). New-message sync is
    // message-correct even though checkpoint writes remain batched.
    const deps = buildFakeDeps(imap, drive, {
      upsertMessagesError: { triggerOnCallNumber: 51, message: "drive 503" },
    });
    const rep = await runSyncOnce(deps, acct, watcherDefault);
    expect(rep.error).toContain("drive 503");
    const stored = drive.folders.get("work")?.get("INBOX");
    expect(stored?.messageIds.size).toBe(50);
    // Checkpoint reflects the last successful batch only.
    expect((stored?.metadata as unknown as SyncState).lastSyncedUid).toBe(50);

    // Second tick replays from UID 51. Drop the failure flag.
    const deps2 = buildFakeDeps(imap, drive);
    const rep2 = await runSyncOnce(deps2, acct, watcherDefault);
    expect(rep2.error).toBeNull();
    const after = drive.folders.get("work")?.get("INBOX");
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
    const before = drive.folders.get("work")?.get("INBOX");
    expect(before?.messageIds.has("100:1")).toBe(true);

    // Second tick at UIDVALIDITY=200 (rollover).
    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 200, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap2, drive), acct, watcherDefault);
    expect(rep.folders[0]?.uidValidityRolled).toBe(true);
    const after = drive.folders.get("work")?.get("INBOX");
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
        ["INBOX", { uidValidity: 1, uidNext: 5, msgs: [mkMsg(1), mkMsg(2), mkMsg(3), mkMsg(4)] }],
      ]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap2, drive), acct, watcherDefault);
    expect(rep.folders[0]?.newMessages).toBe(1); // only UID 4 fetched
    const stored = drive.folders.get("work")?.get("INBOX");
    expect(stored?.messageIds.size).toBe(4);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync -- flag reconciliation preserves body payload fields */
  it("preserves fetched body when reconciling flags in the same tick", async () => {
    const drive: FakeDriveState = { mailboxes: new Map(), folders: new Map() };
    const imap: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 14, uidNext: 95, msgs: [mkMsg(94)] }]]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap, drive), acct, {
      ...watcherDefault,
      flag_reconcile_window: 100,
    });

    expect(rep.error).toBeNull();
    expect(rep.folders[0]?.reconciledFlags).toBe(1);
    const stored = drive.folders.get("work")?.get("INBOX")?.payloads.get("14:94");
    expect(stored?.bodyText).toBe("body");
    expect(stored?.bodyHtml).toBeNull();
    expect(stored?.snippet).toBe("body");
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
    expect(drive.folders.get("work")?.has("Archive")).toBe(true);

    // Second tick: Archive is gone.
    const imap2: FakeImapState = {
      folders: [{ path: "INBOX", specialUse: null }],
      messagesByFolder: new Map([["INBOX", { uidValidity: 1, uidNext: 2, msgs: [mkMsg(1)] }]]),
    };
    const rep = await runSyncOnce(buildFakeDeps(imap2, drive), acct, watcherDefault);
    expect(rep.prunedFolders).toBe(1);
    expect(drive.folders.get("work")?.has("Archive")).toBe(false);
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

/**
 * Drive `messagesStore` payload shape -- opaque JSON to Drive but owned
 * by this server. Keep stable: external consumers (search, agents)
 * can rely on these fields landing in the store mirror.
 *
 * `externalId` (the messagesStore primary key for a message) is built
 * from `${uidValidity}:${uid}` so a UIDVALIDITY rollover never
 * collides with the previous generation.
 */

export type EmailAddress = {
  readonly name: string | null;
  readonly address: string;
};

export type StoredAttachment = {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly partId: string;
  readonly attachmentId?: string;
  readonly driveInode?: string;
  readonly storedSizeBytes?: number;
  readonly storedAt?: string;
};

export type StoredEmailPayload = {
  readonly accountId: string;
  readonly mailbox: string;
  readonly uid: number;
  readonly uidValidity: number;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly from: EmailAddress | null;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly subject: string;
  readonly date: string;
  readonly flags: readonly string[];
  readonly labels: readonly string[];
  readonly hasAttachments: boolean;
  readonly attachments: readonly StoredAttachment[];
  readonly snippet: string;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly truncated: boolean;
  readonly fetchedAt: string;
};

/**
 * Folder metadata used by the watcher to drive idempotent, restart-safe
 * sync. Stored as opaque JSON via `mailbox.folder(...).upsert({metadata})`.
 *
 *  - `uidValidity`: snapshot of last seen UIDVALIDITY; mismatch triggers
 *    a full folder drop+resync.
 *  - `uidNext`: snapshot of last seen UIDNEXT; the head of the sync window.
 *  - `lastSyncedUid`: highest UID confirmed written via successful upsert.
 *    `runSyncOnce` advances this only after a batch upsert returns Ok.
 *  - `lastSyncStartedAt` / `lastSyncFinishedAt` / `lastSyncError`:
 *    diagnostic snapshot exposed via `get_watcher_status`.
 */
export type SyncState = {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly lastSyncedUid: number;
  readonly lastSyncStartedAt: string | null;
  readonly lastSyncFinishedAt: string | null;
  readonly lastSyncError: string | null;
};

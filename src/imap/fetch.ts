/**
 * imapflow fetch helpers used by both the watcher (bulk sync) and the
 * read tools (`get_email`, `get_emails`, `list_emails`). All helpers are
 * BODY.PEEK by default so reads do not silently flip `\\Seen`.
 *
 * Body decoding strategy: we ask imapflow for `bodyParts` (the small
 * `text/plain` and `text/html` pieces) instead of full source -- this
 * keeps payloads bounded without requiring a separate MIME parser. The
 * mapper truncates body byte-size on top.
 */

import type { FetchMessageObject, ImapFlow, MailboxLockObject } from "imapflow";
import type { FetchedMessageLike } from "./mapper.js";

export type FolderStatusSnapshot = {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messages: number;
};

const BODY_PARTS = ["text", "html"] as const;

/**
 * Run a callback under a per-folder IMAP lock. imapflow requires this
 * for any FETCH/STORE/MOVE operation. The lock is released even if the
 * callback throws.
 */
export const withMailboxLock = async <T>(
  client: ImapFlow,
  mailbox: string,
  fn: () => Promise<T>,
): Promise<T> => {
  let lock: MailboxLockObject | null = null;
  try {
    lock = await client.getMailboxLock(mailbox);
    return await fn();
  } finally {
    if (lock !== null) lock.release();
  }
};

export const folderStatus = async (
  client: ImapFlow,
  mailbox: string,
): Promise<FolderStatusSnapshot> => {
  const status = await client.status(mailbox, {
    uidValidity: true,
    uidNext: true,
    messages: true,
  });
  return {
    uidValidity: Number(status.uidValidity ?? 0),
    uidNext: Number(status.uidNext ?? 1),
    messages: Number(status.messages ?? 0),
  };
};

const decodeBuffer = (b: Buffer | undefined | null): string | null => {
  if (!b || b.length === 0) return null;
  return b.toString("utf8");
};

const extractText = (msg: FetchMessageObject): string | null => {
  const candidate = msg.bodyParts?.get("text") ?? msg.bodyParts?.get("1");
  return decodeBuffer(candidate as Buffer | undefined);
};

const extractHtml = (msg: FetchMessageObject): string | null => {
  const candidate = msg.bodyParts?.get("html") ?? msg.bodyParts?.get("1.2");
  return decodeBuffer(candidate as Buffer | undefined);
};

export type FetchedEnvelopeBundle = {
  readonly imapMessage: FetchedMessageLike;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
};

const toInternalDate = (raw: Date | string | undefined): Date | undefined => {
  if (raw instanceof Date) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
};

const toLike = (msg: FetchMessageObject): FetchedMessageLike => ({
  uid: msg.uid,
  flags: msg.flags ?? new Set<string>(),
  envelope: msg.envelope as FetchedMessageLike["envelope"],
  bodyStructure: msg.bodyStructure as FetchedMessageLike["bodyStructure"],
  internalDate: toInternalDate(msg.internalDate as Date | string | undefined),
});

/**
 * UID-range fetch for the watcher. Yields envelope + flags + bodyStructure
 * + bodyParts(text/html) without setting `\\Seen`.
 */
export async function* fetchUidRange(
  client: ImapFlow,
  fromUid: number,
  toUid: number,
): AsyncIterable<FetchedEnvelopeBundle> {
  const range = `${fromUid}:${toUid}`;
  for await (const msg of client.fetch(
    range,
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      bodyParts: BODY_PARTS as unknown as string[],
      internalDate: true,
    },
    { uid: true },
  )) {
    yield {
      imapMessage: toLike(msg),
      bodyText: extractText(msg),
      bodyHtml: extractHtml(msg),
    };
  }
}

/**
 * Fetch a single message by UID with BODY.PEEK semantics. Used by
 * `get_email` and `get_emails`.
 */
export const fetchOneByUid = async (
  client: ImapFlow,
  uid: number,
): Promise<FetchedEnvelopeBundle | null> => {
  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      bodyParts: BODY_PARTS as unknown as string[],
      internalDate: true,
    },
    { uid: true },
  );
  if (!msg) return null;
  return {
    imapMessage: toLike(msg),
    bodyText: extractText(msg),
    bodyHtml: extractHtml(msg),
  };
};

/**
 * Envelope-only fetch over a UID range. Used by `list_emails` and the
 * watcher's flag-reconciliation pass (no body, no bodyStructure).
 */
export async function* fetchEnvelopesUidRange(
  client: ImapFlow,
  fromUid: number,
  toUid: number,
): AsyncIterable<FetchedMessageLike> {
  const range = `${fromUid}:${toUid}`;
  for await (const msg of client.fetch(
    range,
    {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
    },
    { uid: true },
  )) {
    yield toLike(msg);
  }
}

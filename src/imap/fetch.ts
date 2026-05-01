/**
 * imapflow fetch helpers used by both the watcher (bulk sync) and the
 * read tools (`get_email`, `get_emails`, `list_emails`). All helpers are
 * BODY.PEEK by default so reads do not silently flip `\\Seen`.
 *
 * Body decoding strategy: first fetch `BODYSTRUCTURE`, then request the
 * concrete MIME part ids for `text/plain` and `text/html`. Never pass semantic
 * names such as `html` to imapflow: some IMAP servers (OVH) reject
 * `BODY.PEEK[HTML]` with `BAD Command Argument Error. 11`.
 */

import type { FetchMessageObject, ImapFlow, MailboxLockObject } from "imapflow";
import type { FetchedMessageLike } from "./mapper.js";

export type FolderStatusSnapshot = {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messages: number;
};

type BodyPartCandidate = {
  readonly textPartId: string | null;
  readonly htmlPartId: string | null;
};

type BodyStructureNode = {
  readonly type?: string | undefined;
  readonly part?: string | undefined;
  readonly disposition?: string | undefined;
  readonly dispositionParameters?: { readonly filename?: string | undefined } | undefined;
  readonly parameters?: { readonly name?: string | undefined } | undefined;
  readonly childNodes?: readonly BodyStructureNode[] | undefined;
};

const isAttachmentNode = (node: BodyStructureNode): boolean =>
  node.disposition === "attachment" ||
  (node.disposition === "inline" &&
    Boolean(node.dispositionParameters?.filename ?? node.parameters?.name));

const fallbackSinglePartId = (type: string | undefined): string | null => {
  if (type === "text/plain" || type === "text/html") return "1";
  return null;
};

/**
 * Find concrete IMAP body part ids for display bodies.
 * Attachments are skipped.
 */
export const findDisplayBodyPartIds = (bodyStructure: unknown): BodyPartCandidate => {
  const result: { textPartId: string | null; htmlPartId: string | null } = {
    textPartId: null,
    htmlPartId: null,
  };

  const visit = (raw: unknown): void => {
    if (result.textPartId && result.htmlPartId) return;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const node = raw as BodyStructureNode;
    if (isAttachmentNode(node)) return;

    const type = node.type?.toLowerCase();
    const partId = node.part ?? fallbackSinglePartId(type);
    if (type === "text/plain" && partId && !result.textPartId) {
      result.textPartId = partId;
    } else if (type === "text/html" && partId && !result.htmlPartId) {
      result.htmlPartId = partId;
    }

    for (const child of node.childNodes ?? []) {
      visit(child);
    }
  };

  visit(bodyStructure);
  return result;
};

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

const fetchDisplayBodies = async (
  client: ImapFlow,
  uid: number,
  bodyStructure: unknown,
): Promise<{
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
}> => {
  const { textPartId, htmlPartId } = findDisplayBodyPartIds(bodyStructure);
  const partIds = [...new Set([textPartId, htmlPartId].filter((id): id is string => id !== null))];
  if (partIds.length === 0) {
    return { bodyText: null, bodyHtml: null };
  }

  const bodyMsg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      bodyParts: partIds,
    },
    { uid: true },
  );

  const bodyParts = bodyMsg === false ? undefined : bodyMsg.bodyParts;

  return {
    bodyText: textPartId ? decodeBuffer(bodyParts?.get(textPartId) as Buffer | undefined) : null,
    bodyHtml: htmlPartId ? decodeBuffer(bodyParts?.get(htmlPartId) as Buffer | undefined) : null,
  };
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
 * plus display body parts without setting `\\Seen`.
 */
export async function* fetchUidRange(
  client: ImapFlow,
  fromUid: number,
  toUid: number,
): AsyncIterable<FetchedEnvelopeBundle> {
  const range = `${fromUid}:${toUid}`;
  const messages: FetchMessageObject[] = [];
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
    messages.push(msg);
  }

  for (const msg of messages) {
    const bodies = await fetchDisplayBodies(client, msg.uid, msg.bodyStructure);
    yield {
      imapMessage: toLike(msg),
      bodyText: bodies.bodyText,
      bodyHtml: bodies.bodyHtml,
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
      internalDate: true,
    },
    { uid: true },
  );
  if (!msg) return null;
  const bodies = await fetchDisplayBodies(client, msg.uid, msg.bodyStructure);
  return {
    imapMessage: toLike(msg),
    bodyText: bodies.bodyText,
    bodyHtml: bodies.bodyHtml,
  };
};

/**
 * Envelope-only fetch over a UID range. Used by `list_emails` and the
 * watcher's flag-reconciliation pass (no body, no bodyStructure).
 */
export async function* downloadPartByUid(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  partId: string,
): AsyncIterable<Uint8Array> {
  let lock: MailboxLockObject | null = null;
  try {
    lock = await client.getMailboxLock(mailbox);
    const downloaded = await client.download(String(uid), partId, { uid: true });
    for await (const chunk of downloaded.content) {
      if (typeof chunk === "string") {
        yield Buffer.from(chunk);
      } else if (chunk instanceof Uint8Array) {
        yield chunk;
      } else {
        yield Buffer.from(chunk as ArrayBuffer);
      }
    }
  } finally {
    if (lock !== null) lock.release();
  }
}

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

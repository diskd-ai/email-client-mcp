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
  readonly encoding?: string | undefined;
  readonly disposition?: string | undefined;
  readonly dispositionParameters?: { readonly filename?: string | undefined } | undefined;
  readonly parameters?:
    | { readonly name?: string | undefined; readonly charset?: string | undefined }
    | undefined;
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

const findBodyStructureNodeByPartId = (
  bodyStructure: unknown,
  partId: string,
): BodyStructureNode | null => {
  const visit = (raw: unknown): BodyStructureNode | null => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const node = raw as BodyStructureNode;
    const type = node.type?.toLowerCase();
    const nodePartId = node.part ?? fallbackSinglePartId(type);
    if (nodePartId === partId) return node;
    for (const child of node.childNodes ?? []) {
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(bodyStructure);
};

const normalizeToken = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().replace(/^"|"$/g, "").toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeCharset = (charset: string | null | undefined): string => {
  const normalized = normalizeToken(charset);
  if (normalized === null || normalized === "default") return "utf-8";
  if (normalized === "utf8") return "utf-8";
  if (normalized === "latin1" || normalized === "latin-1") return "iso-8859-1";
  if (normalized === "win-1251") return "windows-1251";
  return normalized;
};

const decodeQuotedPrintableBytes = (input: Buffer): Buffer => {
  const text = input.toString("latin1").replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === "=" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
};

const decodeTransferEncodingBytes = (
  input: Buffer,
  transferEncoding: string | null | undefined,
): Buffer => {
  const encoding = normalizeToken(transferEncoding);
  if (encoding === "base64") {
    return Buffer.from(input.toString("ascii").replace(/\s+/g, ""), "base64");
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintableBytes(input);
  }
  return input;
};

const WINDOWS_1251_80_BF =
  "\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F" +
  "\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\uFFFD\u2122\u0459\u203A\u045A\u045C\u045B\u045F" +
  "\u00A0\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407" +
  "\u00B0\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457";

const decodeWindows1251 = (input: Buffer): string => {
  let out = "";
  for (const byte of input) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else if (byte < 0xc0) out += WINDOWS_1251_80_BF[byte - 0x80] ?? "\uFFFD";
    else out += String.fromCharCode(0x0410 + byte - 0xc0);
  }
  return out;
};

const decodeBytesWithCharset = (input: Buffer, charset: string | null | undefined): string => {
  const label = normalizeCharset(charset);
  if (label === "windows-1251") return decodeWindows1251(input).replace(/^\uFEFF/, "");
  try {
    return new TextDecoder(label).decode(input).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("utf-8").decode(input).replace(/^\uFEFF/, "");
  }
};

export const decodeMimeBodyPart = (
  b: Buffer | undefined | null,
  options?: { readonly transferEncoding?: string | null; readonly charset?: string | null },
): string | null => {
  if (!b || b.length === 0) return null;
  const bytes = decodeTransferEncodingBytes(b, options?.transferEncoding);
  return decodeBytesWithCharset(bytes, options?.charset);
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
  const textNode = textPartId ? findBodyStructureNodeByPartId(bodyStructure, textPartId) : null;
  const htmlNode = htmlPartId ? findBodyStructureNodeByPartId(bodyStructure, htmlPartId) : null;
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
    bodyText: textPartId
      ? decodeMimeBodyPart(bodyParts?.get(textPartId) as Buffer | undefined, {
          transferEncoding: textNode?.encoding,
          charset: textNode?.parameters?.charset,
        })
      : null,
    bodyHtml: htmlPartId
      ? decodeMimeBodyPart(bodyParts?.get(htmlPartId) as Buffer | undefined, {
          transferEncoding: htmlNode?.encoding,
          charset: htmlNode?.parameters?.charset,
        })
      : null,
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

export type DownloadedPart = {
  readonly content: AsyncIterable<Uint8Array>;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly dispose: () => void;
};

const openDownloadedPartByUid = async (
  client: ImapFlow,
  mailbox: string,
  uid: number,
  partId: string,
): Promise<DownloadedPart> => {
  const lock = await client.getMailboxLock(mailbox);
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      lock.release();
    }
  };

  try {
    const downloaded = await client.download(String(uid), partId, { uid: true });
    const content = async function* (): AsyncIterable<Uint8Array> {
      try {
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
        release();
      }
    };
    return {
      content: content(),
      sizeBytes: null,
      contentType: downloaded.meta.contentType || null,
      dispose: release,
    };
  } catch (cause) {
    release();
    throw cause;
  }
};

export const downloadPartByUid = async (
  client: ImapFlow,
  mailbox: string,
  uid: number,
  partId: string,
): Promise<DownloadedPart> => {
  // Drive proxy requires an exact Content-Length. imapflow's
  // meta.expectedSize is the IMAP fetch response size for encoded parts,
  // not necessarily the decoded stream byte length. Count one streaming pass,
  // then reopen the same part for the actual upload stream.
  const probe = await openDownloadedPartByUid(client, mailbox, uid, partId);
  let sizeBytes = 0;
  try {
    for await (const chunk of probe.content) {
      sizeBytes += chunk.byteLength;
    }
  } finally {
    probe.dispose();
  }

  const upload = await openDownloadedPartByUid(client, mailbox, uid, partId);
  return { ...upload, sizeBytes };
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

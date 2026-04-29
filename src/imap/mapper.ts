/**
 * Pure mapping from imapflow `FetchMessageObject` to our opaque
 * `StoredEmailPayload`. Kept I/O-free and free of imapflow runtime
 * imports so unit tests can build payload-shaped objects without a
 * real IMAP connection.
 */

import type { EmailAddress, StoredAttachment, StoredEmailPayload } from "../store/payloadTypes.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MiB cap per body part to keep store payloads small
const SNIPPET_CHARS = 200;

type ImapAddressLike = {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
};
type ImapEnvelopeLike = {
  readonly date?: Date | string | undefined;
  readonly subject?: string | undefined;
  readonly messageId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly from?: readonly ImapAddressLike[] | undefined;
  readonly to?: readonly ImapAddressLike[] | undefined;
  readonly cc?: readonly ImapAddressLike[] | undefined;
};

type ImapBodyStructureLike = {
  readonly type?: string | undefined;
  readonly part?: string | undefined;
  readonly disposition?: string | undefined;
  readonly dispositionParameters?: { readonly filename?: string | undefined } | undefined;
  readonly parameters?: { readonly name?: string | undefined } | undefined;
  readonly size?: number | undefined;
  readonly childNodes?: readonly ImapBodyStructureLike[] | undefined;
};

export type FetchedMessageLike = {
  readonly uid: number;
  readonly flags?: ReadonlySet<string> | readonly string[] | undefined;
  readonly labels?: ReadonlySet<string> | readonly string[] | undefined;
  readonly envelope?: ImapEnvelopeLike | undefined;
  readonly bodyStructure?: ImapBodyStructureLike | undefined;
  readonly source?: Buffer | undefined;
  readonly internalDate?: Date | undefined;
};

export type MapperParams = {
  readonly accountId: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly fetchedAt: Date;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly truncated: boolean;
};

const toAddr = (a: ImapAddressLike): EmailAddress => ({
  name: a.name && a.name.length > 0 ? a.name : null,
  address: a.address ?? "",
});

const toAddrArr = (xs: readonly ImapAddressLike[] | undefined): readonly EmailAddress[] =>
  (xs ?? []).map(toAddr).filter((a) => a.address.length > 0);

const toIso = (d: Date | string | undefined, fallback: Date): string => {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string" && d.length > 0) {
    const parsed = new Date(d);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
};

const flagArray = (src: ReadonlySet<string> | readonly string[] | undefined): readonly string[] => {
  if (!src) return [];
  if (src instanceof Set) return Array.from(src);
  return [...src];
};

const collectAttachments = (
  node: ImapBodyStructureLike | undefined,
  out: StoredAttachment[],
): void => {
  if (!node) return;
  const isAttachment =
    node.disposition === "attachment" ||
    (node.disposition === "inline" &&
      (node.dispositionParameters?.filename ?? node.parameters?.name));
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (isAttachment && filename) {
    out.push({
      filename,
      contentType: node.type ?? "application/octet-stream",
      sizeBytes: node.size ?? 0,
      partId: node.part ?? "",
    });
  }
  for (const child of node.childNodes ?? []) {
    collectAttachments(child, out);
  }
};

const truncateBody = (body: string | null): { value: string | null; truncated: boolean } => {
  if (body === null) return { value: null, truncated: false };
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= MAX_BODY_BYTES) return { value: body, truncated: false };
  // Truncate to MAX_BODY_BYTES bytes (UTF-8 safe).
  const buf = Buffer.from(body, "utf8").subarray(0, MAX_BODY_BYTES);
  return { value: buf.toString("utf8"), truncated: true };
};

const buildSnippet = (text: string | null): string => {
  if (text === null) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.slice(0, SNIPPET_CHARS);
};

/**
 * Build a `StoredEmailPayload` from imapflow fetch output and decoded
 * body parts. Pure: no imapflow types are imported, so tests can pass
 * shaped POJOs.
 */
export const toStoredPayload = (
  msg: FetchedMessageLike,
  params: MapperParams,
): StoredEmailPayload => {
  const env = msg.envelope ?? {};
  const attachments: StoredAttachment[] = [];
  collectAttachments(msg.bodyStructure, attachments);
  const bodyText = truncateBody(params.bodyText);
  const bodyHtml = truncateBody(params.bodyHtml);
  const fallbackDate = msg.internalDate ?? params.fetchedAt;

  return {
    accountId: params.accountId,
    mailbox: params.mailbox,
    uid: msg.uid,
    uidValidity: params.uidValidity,
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    references: [],
    from: env.from && env.from.length > 0 ? toAddr(env.from[0] as ImapAddressLike) : null,
    to: toAddrArr(env.to),
    cc: toAddrArr(env.cc),
    subject: env.subject ?? "",
    date: toIso(env.date, fallbackDate),
    flags: flagArray(msg.flags),
    labels: flagArray(msg.labels),
    hasAttachments: attachments.length > 0,
    attachments,
    snippet: buildSnippet(bodyText.value),
    bodyText: bodyText.value,
    bodyHtml: bodyHtml.value,
    truncated: bodyText.truncated || bodyHtml.truncated || params.truncated,
    fetchedAt: params.fetchedAt.toISOString(),
  };
};

/**
 * Strip `text/html` to an approximate plain-text representation. Conservative:
 * removes scripts/styles, replaces tags with spaces, decodes a small set of
 * named entities. Used by the `format="text"` option of get_email/get_emails.
 */
export const htmlToText = (html: string): string => {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const noTags = noScript.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded.replace(/\s+/g, " ").trim();
};

/**
 * Strip quoted reply blocks and signatures from a plain-text body. Heuristic
 * but conservative: cuts at the first `On <date>, <name> wrote:` block, or at
 * a leading-`>` quote run, or at a `-- ` signature delimiter.
 */
export const stripQuotedAndSignature = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^-- $/.test(line)) break;
    if (/^On\s.+wrote:$/.test(line)) break;
    if (/^>+\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trimEnd();
};

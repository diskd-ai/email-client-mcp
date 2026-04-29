/**
 * Pure helpers that map account/folder/UID identity onto the
 * messagesStore namespace. Concentrating these so a future change
 * (e.g. a different mailbox-id scheme) only edits one file.
 */

const MAILBOX_ID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Sanitize an account id for use as a Drive mailbox id (slug subset
 * `[a-z0-9-]{1,64}`). Lowercase, replace anything else with `-`, collapse
 * runs, trim leading/trailing dashes, truncate. Empty input -> 'mailbox'.
 */
export const sanitizeMailboxId = (raw: string): string => {
  const lowered = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const truncated = lowered.slice(0, 64);
  return truncated.length === 0 ? "mailbox" : truncated;
};

/**
 * Caller-supplied folderId for a given IMAP mailbox path. We keep the
 * IMAP path verbatim so `find_mailbox_folder` can round-trip it.
 */
export const folderIdFromImapPath = (imapPath: string): string => imapPath;

/**
 * Build the messagesStore externalId for a message. `${uidValidity}:${uid}`
 * makes the id stable across sync runs and disjoint across UIDVALIDITY
 * generations.
 */
export const externalIdFor = (uidValidity: number, uid: number): string => `${uidValidity}:${uid}`;

/**
 * Parse an externalId back into its components. Returns null on a
 * malformed input -- callers should treat that as "not produced by us".
 */
export const parseExternalId = (
  externalId: string,
): { uidValidity: number; uid: number } | null => {
  const parts = externalId.split(":");
  if (parts.length !== 2) return null;
  const uvRaw = parts[0];
  const uidRaw = parts[1];
  if (uvRaw === undefined || uidRaw === undefined) return null;
  const uv = Number.parseInt(uvRaw, 10);
  const uid = Number.parseInt(uidRaw, 10);
  if (!Number.isFinite(uv) || !Number.isFinite(uid)) return null;
  if (uv < 0 || uid < 0) return null;
  return { uidValidity: uv, uid };
};

export const isValidMailboxId = (id: string): boolean => MAILBOX_ID_RE.test(id);

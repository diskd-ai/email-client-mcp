/**
 * Allowlist of well-known IMAP "virtual" folders. move_email and
 * bulk_action#move refuse these because IMAP MOVE on a virtual mailbox
 * either fails or moves a different message than the agent intended.
 *
 * The list is intentionally short and explicit; `find_mailbox_folder`
 * is the documented path to resolve real folders for messages
 * discovered via virtuals (e.g. Gmail's "[Gmail]/All Mail").
 */

const VIRTUAL_FOLDER_PATHS = new Set<string>([
  "[Gmail]/All Mail",
  "[Gmail]/Starred",
  "[Gmail]/Important",
  "INBOX/All Mail",
  "All Mail",
]);

const VIRTUAL_SPECIAL_USE = new Set<string>(["\\All", "\\Flagged", "\\Important"]);

export const isVirtualFolderPath = (path: string): boolean => VIRTUAL_FOLDER_PATHS.has(path);

export const isVirtualSpecialUse = (specialUse: string | undefined | null): boolean =>
  specialUse !== undefined && specialUse !== null && VIRTUAL_SPECIAL_USE.has(specialUse);

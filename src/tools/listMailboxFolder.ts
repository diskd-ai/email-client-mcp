/**
 * MCP tool: list_mailbox_folder -- IMAP folder list per account with
 * unread counts and special-use flags. Live-IMAP read.
 */

import { z } from "zod";
import { type AppError, errorMessage, imapError, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { withMailboxLock } from "../imap/fetch.js";
import type { ImapPool } from "../imap/pool.js";
import { isVirtualFolderPath, isVirtualSpecialUse } from "../imap/virtualFolders.js";

export const listMailboxFolderInput = z
  .object({
    account: z.string().min(1),
    includeUnreadCount: z.boolean().default(false),
  })
  .strict();
export type ListMailboxFolderInput = z.infer<typeof listMailboxFolderInput>;

export type ListedFolder = {
  readonly path: string;
  readonly name: string;
  readonly delimiter: string;
  readonly specialUse: string | null;
  readonly subscribed: boolean;
  readonly virtual: boolean;
  readonly unreadCount: number | null;
};

export type ListMailboxFolderResult = {
  readonly account: string;
  readonly folders: readonly ListedFolder[];
};

export const listMailboxFolder = async (
  pool: ImapPool,
  input: ListMailboxFolderInput,
): Promise<Result<AppError, ListMailboxFolderResult>> => {
  if (!pool.accountIds.includes(input.account)) {
    return Err(notFound(`account '${input.account}'`));
  }
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    const folders = await client.list();
    const out: ListedFolder[] = [];
    for (const f of folders) {
      const specialUse = (f.specialUse ?? null) as string | null;
      const virtual = isVirtualFolderPath(f.path) || isVirtualSpecialUse(specialUse);
      let unreadCount: number | null = null;
      if (input.includeUnreadCount && !virtual) {
        try {
          const status = await client.status(f.path, { unseen: true });
          unreadCount = Number(status.unseen ?? 0);
        } catch {
          unreadCount = null;
        }
      }
      out.push({
        path: f.path,
        name: f.name,
        delimiter: f.delimiter ?? "/",
        specialUse,
        subscribed: f.subscribed ?? false,
        virtual,
        unreadCount,
      });
    }
    return Ok({ account: input.account, folders: out });
  } catch (cause) {
    return Err(
      imapError(
        input.account,
        errorMessage({ kind: "ImapError", accountId: input.account, message: "list" }),
        cause,
      ),
    );
  } finally {
    // Note: client.list() does not require a per-mailbox lock.
    void withMailboxLock; // silence unused import marker if list doesn't need lock
  }
};

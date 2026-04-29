/**
 * MCP tool: move_email -- IMAP MOVE one message between folders.
 *
 * Refuses virtual mailboxes as the source (Gmail "[Gmail]/All Mail",
 * Starred, etc.) -- callers should use `find_mailbox_folder` first to
 * resolve the real folder.
 */

import { z } from "zod";
import { type AppError, imapError, notFound, virtualFolderRefused } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { withMailboxLock } from "../imap/fetch.js";
import type { ImapPool } from "../imap/pool.js";
import { isVirtualFolderPath } from "../imap/virtualFolders.js";

export const moveEmailInput = z
  .object({
    account: z.string().min(1),
    sourceMailbox: z.string().min(1),
    targetMailbox: z.string().min(1),
    uid: z.number().int().positive(),
  })
  .strict();
export type MoveEmailInput = z.infer<typeof moveEmailInput>;

export type MoveEmailResult = {
  readonly account: string;
  readonly sourceMailbox: string;
  readonly targetMailbox: string;
  readonly uid: number;
  readonly newUid: number | null;
};

export const moveEmail = async (
  pool: ImapPool,
  input: MoveEmailInput,
): Promise<Result<AppError, MoveEmailResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  if (isVirtualFolderPath(input.sourceMailbox)) {
    return Err(virtualFolderRefused(input.sourceMailbox));
  }
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    return await withMailboxLock(client, input.sourceMailbox, async () => {
      const result = await client.messageMove([input.uid], input.targetMailbox, { uid: true });
      if (result === false) {
        return Err(imapError(input.account, "IMAP MOVE returned false (server refused)"));
      }
      const uidMap = result.uidMap as Map<number, number> | undefined;
      const newUid = uidMap?.get(input.uid) ?? null;
      return Ok({
        account: input.account,
        sourceMailbox: input.sourceMailbox,
        targetMailbox: input.targetMailbox,
        uid: input.uid,
        newUid,
      });
    });
  } catch (cause) {
    return Err(imapError(input.account, "move_email failed", cause));
  }
};

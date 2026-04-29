/**
 * MCP tool: find_mailbox_folder -- given a Message-Id, list all real
 * folders that contain a copy of that message. Required pre-step for
 * `move_email` when the message was discovered via a virtual folder
 * (e.g. Gmail "[Gmail]/All Mail").
 *
 * Strategy: list folders, skip virtuals, run UID SEARCH HEADER
 * Message-Id on each, collect the hits.
 */

import { z } from "zod";
import { type AppError, imapError, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { withMailboxLock } from "../imap/fetch.js";
import type { ImapPool } from "../imap/pool.js";
import { isVirtualFolderPath, isVirtualSpecialUse } from "../imap/virtualFolders.js";

export const findMailboxFolderInput = z
  .object({
    account: z.string().min(1),
    messageId: z.string().min(1),
  })
  .strict();
export type FindMailboxFolderInput = z.infer<typeof findMailboxFolderInput>;

export type FindMailboxFolderResult = {
  readonly account: string;
  readonly messageId: string;
  readonly folders: ReadonlyArray<{ readonly path: string; readonly uids: readonly number[] }>;
};

export const findMailboxFolder = async (
  pool: ImapPool,
  input: FindMailboxFolderInput,
): Promise<Result<AppError, FindMailboxFolderResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    const folders = await client.list();
    const hits: { path: string; uids: number[] }[] = [];
    for (const f of folders) {
      const specialUse = (f.specialUse ?? null) as string | null;
      if (isVirtualFolderPath(f.path) || isVirtualSpecialUse(specialUse)) continue;
      const uids = await withMailboxLock(client, f.path, () =>
        client.search({ header: { "message-id": input.messageId } }, { uid: true }),
      );
      if (Array.isArray(uids) && uids.length > 0) hits.push({ path: f.path, uids });
    }
    return Ok({ account: input.account, messageId: input.messageId, folders: hits });
  } catch (cause) {
    return Err(imapError(input.account, "find_mailbox_folder failed", cause));
  }
};

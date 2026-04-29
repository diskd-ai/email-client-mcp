/**
 * MCP tool: bulk_action -- batch operation on a UID list (max 100).
 *
 * Actions:
 *   - mark_read / mark_unread: STORE +/-FLAGS \\Seen
 *   - flag / unflag:           STORE +/-FLAGS \\Flagged
 *   - move:                    MOVE to targetMailbox (refuses virtual sources)
 *   - delete:                  EXPUNGE-style delete
 *
 * Returns per-UID success/failure detail so callers can recover.
 */

import { z } from "zod";
import { type AppError, imapError, notFound, virtualFolderRefused } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { withMailboxLock } from "../imap/fetch.js";
import type { ImapPool } from "../imap/pool.js";
import { isVirtualFolderPath } from "../imap/virtualFolders.js";

const bulkActionEnum = z.enum(["mark_read", "mark_unread", "flag", "unflag", "move", "delete"]);

export const bulkActionInput = z
  .object({
    account: z.string().min(1),
    sourceMailbox: z.string().min(1),
    uids: z.array(z.number().int().positive()).min(1).max(100),
    action: bulkActionEnum,
    targetMailbox: z.string().optional(),
  })
  .strict();
export type BulkActionInput = z.infer<typeof bulkActionInput>;

export type BulkActionResult = {
  readonly action: BulkActionInput["action"];
  readonly succeeded: number;
  readonly failedUids: readonly number[];
};

export const bulkAction = async (
  pool: ImapPool,
  input: BulkActionInput,
): Promise<Result<AppError, BulkActionResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  if (
    input.action === "move" &&
    (input.targetMailbox === undefined || input.targetMailbox.length === 0)
  ) {
    return Err(imapError(input.account, "bulk_action(move) requires targetMailbox"));
  }
  if (input.action === "move" && isVirtualFolderPath(input.sourceMailbox)) {
    return Err(virtualFolderRefused(input.sourceMailbox));
  }
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    return await withMailboxLock(client, input.sourceMailbox, async () => {
      let ok = false;
      switch (input.action) {
        case "mark_read":
          ok = await client.messageFlagsAdd(input.uids, ["\\Seen"], { uid: true });
          break;
        case "mark_unread":
          ok = await client.messageFlagsRemove(input.uids, ["\\Seen"], { uid: true });
          break;
        case "flag":
          ok = await client.messageFlagsAdd(input.uids, ["\\Flagged"], { uid: true });
          break;
        case "unflag":
          ok = await client.messageFlagsRemove(input.uids, ["\\Flagged"], { uid: true });
          break;
        case "move": {
          const r = await client.messageMove(input.uids, input.targetMailbox as string, {
            uid: true,
          });
          ok = r !== false;
          break;
        }
        case "delete":
          ok = await client.messageDelete(input.uids, { uid: true });
          break;
      }
      // imapflow STORE/MOVE/DELETE is all-or-nothing per call; we cannot
      // partition success across UIDs without a per-UID retry. If the
      // server rejected the whole batch, surface every UID as failed.
      return Ok({
        action: input.action,
        succeeded: ok ? input.uids.length : 0,
        failedUids: ok ? [] : [...input.uids],
      });
    });
  } catch (cause) {
    return Err(imapError(input.account, `bulk_action(${input.action}) failed`, cause));
  }
};

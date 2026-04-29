/**
 * MCP tool: list_emails -- paginated metadata listing of a mailbox.
 *
 * Live-IMAP. Combines IMAP UID SEARCH (with optional filters) and
 * envelope-only FETCH for matched UIDs. Pagination is offset-based:
 * the first call returns the highest-UID page, subsequent calls pass
 * the previous page's `nextCursor` (a UID).
 */

import { z } from "zod";
import { type AppError, imapError, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { fetchEnvelopesUidRange, withMailboxLock } from "../imap/fetch.js";
import type { ImapPool } from "../imap/pool.js";

export const listEmailsInput = z
  .object({
    account: z.string().min(1),
    mailbox: z.string().min(1),
    pageSize: z.number().int().min(1).max(200).default(50),
    cursor: z.number().int().nonnegative().nullable().optional(),
    unread: z.boolean().optional(),
    flagged: z.boolean().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    since: z.string().datetime().optional(),
  })
  .strict();
export type ListEmailsInput = z.infer<typeof listEmailsInput>;

export type ListedEmail = {
  readonly uid: number;
  readonly messageId: string | null;
  readonly subject: string;
  readonly from: { readonly name: string | null; readonly address: string } | null;
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly address: string }>;
  readonly date: string;
  readonly flags: readonly string[];
  readonly hasAttachments: boolean;
};

export type ListEmailsResult = {
  readonly account: string;
  readonly mailbox: string;
  readonly items: readonly ListedEmail[];
  readonly nextCursor: number | null;
};

export const listEmails = async (
  pool: ImapPool,
  input: ListEmailsInput,
): Promise<Result<AppError, ListEmailsResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    return await withMailboxLock(client, input.mailbox, async () => {
      type SearchClause = Readonly<Record<string, unknown>>;
      const query: SearchClause = {
        ...(input.unread === true ? { unseen: true } : {}),
        ...(input.unread === false ? { seen: true } : {}),
        ...(input.flagged === true ? { flagged: true } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.since ? { since: new Date(input.since) } : {}),
      };

      const allUidsResult = await client.search(query as unknown as Record<string, unknown>, {
        uid: true,
      });
      const allUids = Array.isArray(allUidsResult)
        ? allUidsResult.slice().sort((a, b) => b - a)
        : [];
      const cursor = input.cursor ?? null;
      const startIdx = cursor === null ? 0 : allUids.findIndex((u) => u < cursor);
      const safeStart = startIdx === -1 ? allUids.length : startIdx;
      const pageUids = allUids.slice(safeStart, safeStart + input.pageSize);
      const nextCursor =
        safeStart + input.pageSize < allUids.length
          ? (pageUids[pageUids.length - 1] ?? null)
          : null;

      if (pageUids.length === 0) {
        return Ok({ account: input.account, mailbox: input.mailbox, items: [], nextCursor });
      }
      const minUid = Math.min(...pageUids);
      const maxUid = Math.max(...pageUids);
      const wanted = new Set(pageUids);
      const items: ListedEmail[] = [];
      for await (const env of fetchEnvelopesUidRange(client, minUid, maxUid)) {
        if (!wanted.has(env.uid)) continue;
        const e = env.envelope ?? {};
        items.push({
          uid: env.uid,
          messageId: e.messageId ?? null,
          subject: e.subject ?? "",
          from:
            e.from && e.from.length > 0 && e.from[0]
              ? {
                  name: e.from[0].name && e.from[0].name.length > 0 ? e.from[0].name : null,
                  address: e.from[0].address ?? "",
                }
              : null,
          to: (e.to ?? []).map((a) => ({
            name: a.name && a.name.length > 0 ? a.name : null,
            address: a.address ?? "",
          })),
          date:
            e.date instanceof Date
              ? e.date.toISOString()
              : typeof e.date === "string"
                ? new Date(e.date).toISOString()
                : "",
          flags: env.flags instanceof Set ? Array.from(env.flags) : [...(env.flags ?? [])],
          hasAttachments: false,
        });
      }
      // Sort by UID descending to match the cursor walk.
      items.sort((a, b) => b.uid - a.uid);
      return Ok({ account: input.account, mailbox: input.mailbox, items, nextCursor });
    });
  } catch (cause) {
    return Err(imapError(input.account, "list_emails failed", cause));
  }
};

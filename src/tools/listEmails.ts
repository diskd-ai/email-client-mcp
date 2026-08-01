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
import { toStoredPayload } from "../imap/mapper.js";
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
    cc: z.string().optional(),
    subject: z.string().optional(),
    since: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
    textTerms: z.array(z.string().min(1)).min(1).max(20).optional(),
  })
  .strict();
export type ListEmailsInput = z.infer<typeof listEmailsInput>;

export type ListedEmail = {
  readonly uid: number;
  readonly messageId: string | null;
  readonly subject: string;
  readonly from: { readonly name: string | null; readonly address: string } | null;
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly address: string }>;
  readonly cc: ReadonlyArray<{ readonly name: string | null; readonly address: string }>;
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
        ...(input.cc ? { cc: input.cc } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.since ? { since: new Date(input.since) } : {}),
        ...(input.before ? { before: new Date(input.before) } : {}),
      };

      /** Run one native IMAP search and normalize non-array server responses to no matches. */
      const searchUids = async (textTerm?: string): Promise<readonly number[]> => {
        const result = await client.search(
          { ...query, ...(textTerm ? { text: textTerm } : {}) } as unknown as Record<
            string,
            unknown
          >,
          { uid: true },
        );
        return Array.isArray(result) ? result : [];
      };
      const textTerms = input.textTerms ?? [];
      let allUids = [...(await searchUids(textTerms[0]))];
      for (const textTerm of textTerms.slice(1)) {
        const matching = new Set(await searchUids(textTerm));
        allUids = allUids.filter((uid) => matching.has(uid));
        if (allUids.length === 0) break;
      }
      allUids.sort((a, b) => b - a);
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
        const payload = toStoredPayload(env, {
          accountId: input.account,
          mailbox: input.mailbox,
          uidValidity: 0,
          fetchedAt: new Date(),
          bodyText: null,
          bodyHtml: null,
          truncated: false,
        });
        items.push({
          uid: env.uid,
          messageId: payload.messageId,
          subject: payload.subject,
          from: payload.from,
          to: payload.to,
          cc: payload.cc,
          date: payload.date,
          flags: payload.flags,
          hasAttachments: payload.hasAttachments,
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

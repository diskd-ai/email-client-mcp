/**
 * MCP tool: get_emails -- bulk variant of get_email (max 20). One IMAP
 * lock + one FETCH for the UID set. BODY.PEEK; never sets `\Seen`.
 */

import { z } from "zod";
import { type AppError, imapError, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { fetchEnvelopesUidRange, withMailboxLock } from "../imap/fetch.js";
import { htmlToText, stripQuotedAndSignature, toStoredPayload } from "../imap/mapper.js";
import type { ImapPool } from "../imap/pool.js";
import type { StoredEmailPayload } from "../store/payloadTypes.js";

export const getEmailsInput = z
  .object({
    account: z.string().min(1),
    mailbox: z.string().min(1),
    uids: z.array(z.number().int().positive()).min(1).max(20),
    format: z.enum(["raw", "text", "stripped"]).default("text"),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();
export type GetEmailsInput = z.infer<typeof getEmailsInput>;

export type GetEmailsItem = {
  readonly email: StoredEmailPayload;
  readonly bodyForDisplay: string | null;
};

export type GetEmailsResult = {
  readonly items: readonly GetEmailsItem[];
  readonly missing: readonly number[];
};

const display = (
  p: StoredEmailPayload,
  fmt: GetEmailsInput["format"],
  cap: number | undefined,
): string | null => {
  let txt: string | null = p.bodyText;
  if (txt === null && p.bodyHtml !== null) txt = htmlToText(p.bodyHtml);
  if (txt === null) return null;
  if (fmt === "stripped") txt = stripQuotedAndSignature(txt);
  if (cap !== undefined && txt.length > cap) txt = txt.slice(0, cap);
  return txt;
};

export const getEmails = async (
  pool: ImapPool,
  input: GetEmailsInput,
): Promise<Result<AppError, GetEmailsResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    return await withMailboxLock(client, input.mailbox, async () => {
      const status = await client.status(input.mailbox, { uidValidity: true });
      const wanted = new Set(input.uids);
      const items: GetEmailsItem[] = [];
      const seen = new Set<number>();
      const minUid = Math.min(...input.uids);
      const maxUid = Math.max(...input.uids);
      for await (const env of fetchEnvelopesUidRange(client, minUid, maxUid)) {
        if (!wanted.has(env.uid)) continue;
        const payload = toStoredPayload(env, {
          accountId: input.account,
          mailbox: input.mailbox,
          uidValidity: Number(status.uidValidity ?? 0),
          fetchedAt: new Date(),
          bodyText: null,
          bodyHtml: null,
          truncated: false,
        });
        items.push({
          email: payload,
          bodyForDisplay: display(payload, input.format, input.maxLength),
        });
        seen.add(env.uid);
      }
      const missing = input.uids.filter((u) => !seen.has(u));
      return Ok({ items, missing });
    });
  } catch (cause) {
    return Err(imapError(input.account, "get_emails failed", cause));
  }
};

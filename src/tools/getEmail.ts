/**
 * MCP tool: get_email -- fetch one email by UID with BODY.PEEK.
 *
 * Live-IMAP. Defaults `markRead=false` so the IMAP `\Seen` flag is not
 * touched. Format: "raw" returns the structured payload; "text" strips
 * HTML; "stripped" additionally drops quoted replies and signatures.
 */

import { z } from "zod";
import { type AppError, imapError, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { fetchOneByUid, withMailboxLock } from "../imap/fetch.js";
import { htmlToText, stripQuotedAndSignature, toStoredPayload } from "../imap/mapper.js";
import type { ImapPool } from "../imap/pool.js";
import type { StoredEmailPayload } from "../store/payloadTypes.js";

export const getEmailInput = z
  .object({
    account: z.string().min(1),
    mailbox: z.string().min(1),
    uid: z.number().int().positive(),
    format: z.enum(["raw", "text", "stripped"]).default("raw"),
    maxLength: z.number().int().positive().optional(),
    markRead: z.boolean().default(false),
  })
  .strict();
export type GetEmailInput = z.infer<typeof getEmailInput>;

export type GetEmailResult = {
  readonly email: StoredEmailPayload;
  readonly bodyForDisplay: string | null;
  readonly markedRead: boolean;
};

const buildDisplayBody = (
  payload: StoredEmailPayload,
  format: GetEmailInput["format"],
  maxLength: number | undefined,
): string | null => {
  let text: string | null = payload.bodyText;
  if (text === null && payload.bodyHtml !== null) text = htmlToText(payload.bodyHtml);
  if (text === null) return null;
  if (format === "stripped") text = stripQuotedAndSignature(text);
  if (maxLength !== undefined && text.length > maxLength) text = text.slice(0, maxLength);
  return text;
};

export const getEmail = async (
  pool: ImapPool,
  input: GetEmailInput,
): Promise<Result<AppError, GetEmailResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;
  try {
    return await withMailboxLock(client, input.mailbox, async () => {
      // Capture UIDVALIDITY so the produced payload has a stable externalId.
      const status = await client.status(input.mailbox, { uidValidity: true });
      const bundle = await fetchOneByUid(client, input.uid);
      if (bundle === null) {
        return Err(notFound(`message UID ${input.uid} in ${input.mailbox}`));
      }
      const payload = toStoredPayload(bundle.imapMessage, {
        accountId: input.account,
        mailbox: input.mailbox,
        uidValidity: Number(status.uidValidity ?? 0),
        fetchedAt: new Date(),
        bodyText: bundle.bodyText,
        bodyHtml: bundle.bodyHtml,
        truncated: false,
      });
      const display =
        input.format === "raw"
          ? (payload.bodyText ?? (payload.bodyHtml !== null ? htmlToText(payload.bodyHtml) : null))
          : buildDisplayBody(payload, input.format, input.maxLength);
      let markedRead = false;
      if (input.markRead === true) {
        const ok = await client.messageFlagsAdd([input.uid], ["\\Seen"], { uid: true });
        markedRead = ok === true;
      }
      return Ok({ email: payload, bodyForDisplay: display, markedRead });
    });
  } catch (cause) {
    return Err(imapError(input.account, "get_email failed", cause));
  }
};

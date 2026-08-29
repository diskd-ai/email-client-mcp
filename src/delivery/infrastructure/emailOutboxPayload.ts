import type { EmailOutboxContact, EmailOutboxPayload } from "@diskd-ai/sdk";
import { z } from "zod";
import { Err, Ok, type Result } from "../../domain/result.js";

const senderContactSchema: z.ZodType<EmailOutboxContact> = z.object({
  name: z.string(),
  address: z.string().min(1),
});

const recipientContactSchema: z.ZodType<EmailOutboxContact> = z.object({
  name: z.string(),
  address: z.string().email(),
});

const emailOutboxPayloadSchema: z.ZodType<EmailOutboxPayload> = z.object({
  messageId: z.string().min(1),
  account: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  inReplyTo: z.string().min(1).nullable(),
  from: senderContactSchema,
  to: z.array(recipientContactSchema).min(1),
  cc: z.array(recipientContactSchema),
  bcc: z.array(recipientContactSchema),
  subject: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string(),
  hasAttachments: z.literal(false),
  attachments: z.tuple([]),
});

export type EmailOutboxPayloadError = {
  readonly kind: "InvalidEmailOutboxPayload";
  readonly issues: readonly string[];
};

export const parseEmailOutboxPayload = (
  rawPayload: unknown,
  expectedAccount: string,
): Result<EmailOutboxPayloadError, EmailOutboxPayload> => {
  const parsed = emailOutboxPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return Err({
      kind: "InvalidEmailOutboxPayload",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  if (parsed.data.account !== expectedAccount) {
    return Err({
      kind: "InvalidEmailOutboxPayload",
      issues: ["account: payload account does not match the stored Outbox account"],
    });
  }
  return Ok(parsed.data);
};

import type { EmailOutboxAttachment, EmailOutboxContact, EmailOutboxPayload } from "@diskd-ai/sdk";
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

const emailOutboxAttachmentSchema: z.ZodType<EmailOutboxAttachment> = z
  .object({
    path: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().min(1),
  })
  .strict();

const emailOutboxPayloadFields = {
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
};

const emailOutboxPayloadSchema = z.discriminatedUnion("hasAttachments", [
  z.object({
    ...emailOutboxPayloadFields,
    hasAttachments: z.literal(false),
    attachments: z.tuple([]),
  }),
  z.object({
    ...emailOutboxPayloadFields,
    hasAttachments: z.literal(true),
    attachments: z.array(emailOutboxAttachmentSchema).min(1),
  }),
]);

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
  if (!parsed.data.hasAttachments) return Ok(parsed.data);
  const [firstAttachment, ...remainingAttachments] = parsed.data.attachments;
  if (firstAttachment === undefined) {
    return Err({
      kind: "InvalidEmailOutboxPayload",
      issues: ["attachments: at least one Drive attachment reference is required"],
    });
  }
  const value: EmailOutboxPayload = {
    ...parsed.data,
    attachments: [firstAttachment, ...remainingAttachments],
  };
  return Ok(value);
};

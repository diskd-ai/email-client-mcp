import { createHash } from "node:crypto";
import { z } from "zod";
import { Err, Ok, type Result } from "../../domain/result.js";
import { isValidMailboxId } from "../../store/conventions.js";

const OUTBOX_CREATED_TYPE = "exchange.outbox.created";

export const outboxCreatedSubject = (workspaceId: string): string =>
  `platform.${workspaceId}.${OUTBOX_CREATED_TYPE}`;

const outboxEventDataSchema = z
  .object({
    account: z.string().min(1),
    mailboxId: z.string().refine(isValidMailboxId, "invalid mailboxId"),
    externalId: z.string().min(1),
    revision: z.string().min(1),
  })
  .strict();

const outboxCreatedEnvelopeSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    type: z.literal(OUTBOX_CREATED_TYPE),
    workspace_id: z.string().min(1),
    timestamp: z.string().datetime({ offset: true }),
    version: z.literal(1),
    data: outboxEventDataSchema,
  })
  .strict();

export type OutboxCreatedEvent = {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly account: string;
  readonly mailboxId: string;
  readonly externalId: string;
  readonly revision: string;
};

export type OutboxEventError =
  | { readonly kind: "InvalidEvent"; readonly issues: readonly string[] }
  | {
      readonly kind: "WrongWorkspace";
      readonly expectedWorkspaceId: string;
      readonly actualWorkspaceId: string;
    }
  | {
      readonly kind: "EventIdMismatch";
      readonly expectedEventId: string;
      readonly actualEventId: string;
    };

export const createOutboxEventId = (input: {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly externalId: string;
  readonly revision: string;
}): string =>
  createHash("sha256")
    .update(
      [
        input.workspaceId,
        input.mailboxId,
        input.externalId,
        input.revision,
        OUTBOX_CREATED_TYPE,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");

export const parseOutboxCreatedEvent = (
  rawEvent: unknown,
  expectedWorkspaceId: string,
): Result<OutboxEventError, OutboxCreatedEvent> => {
  const parsed = outboxCreatedEnvelopeSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return Err({
      kind: "InvalidEvent",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }

  if (parsed.data.workspace_id !== expectedWorkspaceId) {
    return Err({
      kind: "WrongWorkspace",
      expectedWorkspaceId,
      actualWorkspaceId: parsed.data.workspace_id,
    });
  }

  const expectedEventId = createOutboxEventId({
    workspaceId: parsed.data.workspace_id,
    mailboxId: parsed.data.data.mailboxId,
    externalId: parsed.data.data.externalId,
    revision: parsed.data.data.revision,
  });
  if (parsed.data.id !== expectedEventId) {
    return Err({
      kind: "EventIdMismatch",
      expectedEventId,
      actualEventId: parsed.data.id,
    });
  }

  return Ok({
    eventId: parsed.data.id,
    workspaceId: parsed.data.workspace_id,
    occurredAt: parsed.data.timestamp,
    account: parsed.data.data.account,
    mailboxId: parsed.data.data.mailboxId,
    externalId: parsed.data.data.externalId,
    revision: parsed.data.data.revision,
  });
};

import { z } from "zod";
import type { AppError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import {
  type BodyHydrationBatchResult,
  type BodyHydrationDeps,
  hydrateStoredMessageBodies,
} from "../sync/bodyHydration.js";

const messageRefInput = z
  .object({
    mailboxId: z.string().min(1),
    folderId: z.string().min(1),
    externalId: z.string().min(1),
  })
  .strict();

export const systemHydrateEmailBodiesInput = z
  .object({
    messages: z.array(messageRefInput).min(1).max(50),
    refresh: z.boolean().default(false),
    maxMessages: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export type SystemHydrateEmailBodiesInput = z.infer<typeof systemHydrateEmailBodiesInput>;
export type SystemHydrateEmailBodiesResult = BodyHydrationBatchResult;

export const systemHydrateEmailBodies = async (
  deps: BodyHydrationDeps,
  input: SystemHydrateEmailBodiesInput,
): Promise<Result<AppError, SystemHydrateEmailBodiesResult>> =>
  hydrateStoredMessageBodies(deps, input.messages, {
    refresh: input.refresh,
    maxMessages: input.maxMessages,
  });

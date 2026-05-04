import { z } from "zod";
import type { AppError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import {
  type AttachmentHydrationDeps,
  type AttachmentHydrationOutcome,
  hydrateStoredMessageAttachment,
} from "../sync/attachmentHydration.js";

export const systemHydrateEmailAttachmentInput = z
  .object({
    mailboxId: z.string().min(1),
    folderId: z.string().min(1),
    externalId: z.string().min(1),
    attachmentId: z.string().min(1),
    refresh: z.boolean().default(false),
  })
  .strict();

export type SystemHydrateEmailAttachmentInput = z.infer<typeof systemHydrateEmailAttachmentInput>;
export type SystemHydrateEmailAttachmentResult = AttachmentHydrationOutcome;

export const systemHydrateEmailAttachment = async (
  deps: AttachmentHydrationDeps,
  input: SystemHydrateEmailAttachmentInput,
): Promise<Result<AppError, SystemHydrateEmailAttachmentResult>> =>
  hydrateStoredMessageAttachment(deps, input, { refresh: input.refresh });

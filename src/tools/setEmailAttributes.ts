/**
 * MCP tool core: set_email_attributes.
 *
 * IMAP is the source of truth for read/flagged state. After a successful
 * STORE, this tool patches the Drive messagesStore mirror so Exchange can
 * reflect the state change before the next watcher reconciliation tick.
 */

import { z } from "zod";
import {
  type AppError,
  errorMessage,
  imapError,
  notFound,
  toolInputError,
  virtualFolderRefused,
} from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { fetchMetadataByUids, withMailboxLock } from "../imap/fetch.js";
import type { FetchedMessageLike } from "../imap/mapper.js";
import type { ImapPool } from "../imap/pool.js";
import { isVirtualFolderPath } from "../imap/virtualFolders.js";
import { externalIdFor, folderIdFromImapPath, sanitizeMailboxId } from "../store/conventions.js";

export type MessageMirrorPatchStore = {
  readonly patchMessages: (
    mailboxId: string,
    folderId: string,
    patches: readonly {
      readonly externalId: string;
      readonly payloadPatch: Readonly<Record<string, unknown>>;
    }[],
  ) => Promise<Result<AppError, { patched: number; missingExternalIds: readonly string[] }>>;
};

const attributesSchema = z
  .object({
    read: z.boolean().optional(),
    flagged: z.boolean().optional(),
  })
  .strict()
  .refine((attributes) => attributes.read !== undefined || attributes.flagged !== undefined, {
    message: "at least one attribute is required",
  });

export const setEmailAttributesInput = z
  .object({
    account: z.string().min(1),
    mailbox: z.string().min(1),
    uids: z.array(z.number().int().positive()).min(1).max(100),
    attributes: attributesSchema,
  })
  .strict();

export type SetEmailAttributesInput = z.infer<typeof setEmailAttributesInput>;

export type SetEmailAttributesResult = {
  readonly account: string;
  readonly mailbox: string;
  readonly uids: readonly number[];
  readonly applied: SetEmailAttributesInput["attributes"];
  readonly imap: {
    readonly succeeded: number;
    readonly failedUids: readonly number[];
  };
  readonly messages: readonly {
    readonly uid: number;
    readonly externalId: string;
    readonly flags: readonly string[];
    readonly labels: readonly string[];
  }[];
  readonly mirrorPatch:
    | {
        readonly tag: "patched";
        readonly patched: number;
        readonly missingExternalIds: readonly string[];
      }
    | { readonly tag: "skipped"; readonly reason: "no_imap_successes" }
    | { readonly tag: "failed"; readonly error: string };
};

/** Convert IMAP flag collection shapes into deterministic arrays for patching. */
const collectionToArray = (
  source: ReadonlySet<string> | readonly string[] | undefined,
): readonly string[] => {
  if (source === undefined) return [];
  return source instanceof Set ? Array.from(source) : [...source];
};

/** Apply one boolean attribute by adding or removing the matching IMAP flag. */
const applyBooleanFlag = async (
  client: {
    readonly messageFlagsAdd: (
      uids: number[],
      flags: string[],
      options: { readonly uid: true },
    ) => Promise<boolean>;
    readonly messageFlagsRemove: (
      uids: number[],
      flags: string[],
      options: { readonly uid: true },
    ) => Promise<boolean>;
  },
  uids: readonly number[],
  desired: boolean | undefined,
  flag: string,
): Promise<boolean> => {
  if (desired === undefined) return true;
  const uidList = [...uids];
  return desired
    ? await client.messageFlagsAdd(uidList, [flag], { uid: true })
    : await client.messageFlagsRemove(uidList, [flag], { uid: true });
};

/** Build a mirror message result from authoritative post-mutation IMAP metadata. */
const toMirrorMessage = (
  uidValidity: number,
  message: FetchedMessageLike,
): SetEmailAttributesResult["messages"][number] => ({
  uid: message.uid,
  externalId: externalIdFor(uidValidity, message.uid),
  flags: collectionToArray(message.flags),
  labels: collectionToArray(message.labels),
});

/** Patch the Drive messagesStore mirror after IMAP confirms the mutation. */
const patchMirror = async (
  mirror: MessageMirrorPatchStore,
  account: string,
  mailbox: string,
  messages: SetEmailAttributesResult["messages"],
): Promise<SetEmailAttributesResult["mirrorPatch"]> => {
  if (messages.length === 0) return { tag: "skipped", reason: "no_imap_successes" };
  const patched = await mirror.patchMessages(
    sanitizeMailboxId(account),
    folderIdFromImapPath(mailbox),
    messages.map((message) => ({
      externalId: message.externalId,
      payloadPatch: {
        flags: message.flags,
        labels: message.labels,
        fetchedAt: new Date().toISOString(),
      },
    })),
  );
  if (patched.tag === "Err") return { tag: "failed", error: errorMessage(patched.error) };
  return {
    tag: "patched",
    patched: patched.value.patched,
    missingExternalIds: patched.value.missingExternalIds,
  };
};

/** Set read/unread and flagged/unflagged attributes through IMAP, then patch the mirror. */
export const setEmailAttributes = async (
  pool: ImapPool,
  mirror: MessageMirrorPatchStore,
  input: SetEmailAttributesInput,
): Promise<Result<AppError, SetEmailAttributesResult>> => {
  if (!pool.accountIds.includes(input.account)) return Err(notFound(`account '${input.account}'`));
  if (isVirtualFolderPath(input.mailbox)) return Err(virtualFolderRefused(input.mailbox));
  if (input.attributes.read === undefined && input.attributes.flagged === undefined) {
    return Err(toolInputError("set_email_attributes requires at least one attribute"));
  }

  const clientR = await pool.forAccount(input.account);
  if (clientR.tag === "Err") return clientR;
  const client = clientR.value;

  try {
    const mutation = await withMailboxLock(client, input.mailbox, async () => {
      const status = await client.status(input.mailbox, { uidValidity: true });
      const uidValidity = Number(status.uidValidity ?? 0);
      const readOk = await applyBooleanFlag(client, input.uids, input.attributes.read, "\\Seen");
      const flaggedOk = await applyBooleanFlag(
        client,
        input.uids,
        input.attributes.flagged,
        "\\Flagged",
      );
      if (!readOk || !flaggedOk) {
        return {
          uidValidity,
          messages: [],
          failedUids: [...input.uids],
        };
      }

      const metadata = await fetchMetadataByUids(client, input.uids);
      const foundUids = new Set(metadata.map((message) => message.uid));
      return {
        uidValidity,
        messages: metadata.map((message) => toMirrorMessage(uidValidity, message)),
        failedUids: input.uids.filter((uid) => !foundUids.has(uid)),
      };
    });

    const mirrorPatch = await patchMirror(mirror, input.account, input.mailbox, mutation.messages);
    return Ok({
      account: input.account,
      mailbox: input.mailbox,
      uids: input.uids,
      applied: input.attributes,
      imap: {
        succeeded: mutation.messages.length,
        failedUids: mutation.failedUids,
      },
      messages: mutation.messages,
      mirrorPatch,
    });
  } catch (cause) {
    return Err(imapError(input.account, "set_email_attributes failed", cause));
  }
};

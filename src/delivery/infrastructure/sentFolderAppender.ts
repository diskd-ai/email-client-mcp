import { Err, Ok, type Result } from "../../domain/result.js";

type SentFolder = {
  readonly path: string;
  readonly specialUse?: string;
};

type AppendReceipt = {
  readonly destination: string;
  readonly uidValidity?: bigint;
  readonly uid?: number;
};

type SentFolderClient = {
  readonly list: () => Promise<readonly SentFolder[]>;
  readonly append: (
    path: string,
    rawMessage: Buffer,
    flags: string[],
    internalDate: Date,
  ) => Promise<AppendReceipt | false>;
};

type SentFolderPool = {
  readonly forAccount: (
    accountId: string,
  ) => Promise<Result<{ readonly message?: string }, SentFolderClient>>;
};

export type SentFolderAppendReceipt = {
  readonly folder: string;
  readonly uidValidity: string;
  readonly uid: string;
};

export type SentFolderAppendError =
  | {
      readonly kind: "SentAccountUnavailable";
      readonly accountId: string;
      readonly message: string;
    }
  | { readonly kind: "SentFolderListFailed"; readonly accountId: string; readonly message: string }
  | { readonly kind: "SentFolderMissing"; readonly accountId: string }
  | { readonly kind: "SentAppendFailed"; readonly accountId: string; readonly message: string }
  | { readonly kind: "SentAppendReceiptMissing"; readonly accountId: string };

export type SentFolderAppender = {
  readonly append: (
    accountId: string,
    rawMessage: Buffer,
    internalDate: Date,
  ) => Promise<Result<SentFolderAppendError, SentFolderAppendReceipt>>;
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const buildSentFolderAppender = (pool: SentFolderPool): SentFolderAppender => ({
  append: async (accountId, rawMessage, internalDate) => {
    const connected = await pool.forAccount(accountId);
    if (connected.tag === "Err") {
      return Err({
        kind: "SentAccountUnavailable",
        accountId,
        message: connected.error.message ?? "IMAP account unavailable",
      });
    }

    let folders: readonly SentFolder[];
    try {
      folders = await connected.value.list();
    } catch (cause) {
      return Err({
        kind: "SentFolderListFailed",
        accountId,
        message: causeMessage(cause),
      });
    }
    const sentFolder = folders.find((folder) => folder.specialUse === "\\Sent");
    if (sentFolder === undefined) return Err({ kind: "SentFolderMissing", accountId });

    try {
      const appended = await connected.value.append(
        sentFolder.path,
        rawMessage,
        ["\\Seen"],
        internalDate,
      );
      if (appended === false || appended.uidValidity === undefined || appended.uid === undefined) {
        return Err({ kind: "SentAppendReceiptMissing", accountId });
      }
      return Ok({
        folder: appended.destination,
        uidValidity: appended.uidValidity.toString(),
        uid: appended.uid.toString(),
      });
    } catch (cause) {
      return Err({
        kind: "SentAppendFailed",
        accountId,
        message: causeMessage(cause),
      });
    }
  },
});

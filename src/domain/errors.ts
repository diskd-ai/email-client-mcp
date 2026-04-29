/**
 * Typed errors used across modules. Adapters convert raw exceptions
 * (imapflow, fetch, fs) into one of these so the domain stays pure.
 */

export type ConfigError = {
  readonly kind: "ConfigError";
  readonly message: string;
  readonly cause?: unknown;
};
export type ImapError = {
  readonly kind: "ImapError";
  readonly accountId: string;
  readonly message: string;
  readonly cause?: unknown;
};
export type DriveError = {
  readonly kind: "DriveError";
  readonly message: string;
  readonly cause?: unknown;
};
export type NotFoundError = { readonly kind: "NotFound"; readonly what: string };
export type VirtualFolderRefused = {
  readonly kind: "VirtualFolderRefused";
  readonly mailbox: string;
};
export type ToolInputError = { readonly kind: "ToolInputError"; readonly message: string };

export type AppError =
  | ConfigError
  | ImapError
  | DriveError
  | NotFoundError
  | VirtualFolderRefused
  | ToolInputError;

export const configError = (message: string, cause?: unknown): ConfigError => ({
  kind: "ConfigError",
  message,
  cause,
});
export const imapError = (accountId: string, message: string, cause?: unknown): ImapError => ({
  kind: "ImapError",
  accountId,
  message,
  cause,
});
export const driveError = (message: string, cause?: unknown): DriveError => ({
  kind: "DriveError",
  message,
  cause,
});
export const notFound = (what: string): NotFoundError => ({ kind: "NotFound", what });
export const virtualFolderRefused = (mailbox: string): VirtualFolderRefused => ({
  kind: "VirtualFolderRefused",
  mailbox,
});
export const toolInputError = (message: string): ToolInputError => ({
  kind: "ToolInputError",
  message,
});

export const errorMessage = (e: AppError): string => {
  switch (e.kind) {
    case "ConfigError":
      return `config: ${e.message}`;
    case "ImapError":
      return `imap[${e.accountId}]: ${e.message}`;
    case "DriveError":
      return `drive: ${e.message}`;
    case "NotFound":
      return `not found: ${e.what}`;
    case "VirtualFolderRefused":
      return `refusing to operate on virtual mailbox: ${e.mailbox}`;
    case "ToolInputError":
      return `bad tool input: ${e.message}`;
  }
};

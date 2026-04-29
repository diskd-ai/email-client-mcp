/**
 * Bind tool implementations to the MCP server using the modern
 * `registerTool(name, config, cb)` API. Each handler returns
 * `{content:[{type:'text', text}]}` (success) or `{isError:true, ...}`
 * (typed AppError). Stringified JSON keeps the transport simple for
 * any client; agents parse it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account } from "../config/schema.js";
import { type AppError, errorMessage } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { ImapPool } from "../imap/pool.js";
import type { Watcher } from "../sync/watcher.js";
import { bulkAction, bulkActionInput } from "./bulkAction.js";
import { findMailboxFolder, findMailboxFolderInput } from "./findMailboxFolder.js";
import { getEmail, getEmailInput } from "./getEmail.js";
import { getEmails, getEmailsInput } from "./getEmails.js";
import { getWatcherStatus, getWatcherStatusInput } from "./getWatcherStatus.js";
import { listAccounts, listAccountsInput } from "./listAccounts.js";
import { listEmails, listEmailsInput } from "./listEmails.js";
import { listMailboxFolder, listMailboxFolderInput } from "./listMailboxFolder.js";
import { moveEmail, moveEmailInput } from "./moveEmail.js";

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (value: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const err = (e: AppError): ToolResponse => ({
  content: [{ type: "text", text: errorMessage(e) }],
  isError: true,
});

const fromResult = <T>(r: Result<AppError, T>): ToolResponse =>
  r.tag === "Ok" ? ok(r.value) : err(r.error);

export type ToolDeps = {
  readonly accounts: readonly Account[];
  readonly imapPool: ImapPool;
  readonly watcher: Watcher;
};

export const registerTools = (server: McpServer, deps: ToolDeps): void => {
  server.registerTool(
    "list_accounts",
    {
      description:
        "List all configured email accounts. Call this first to discover available account names for use with other tools.",
      inputSchema: listAccountsInput.shape,
    },
    async () => ok(listAccounts(deps.accounts)),
  );

  server.registerTool(
    "list_mailbox_folder",
    {
      description:
        "List all mailbox folders for an account with unread counts and special-use flags. Use list_accounts first to get the account name.",
      inputSchema: listMailboxFolderInput.shape,
    },
    async (args) => fromResult(await listMailboxFolder(deps.imapPool, args)),
  );

  server.registerTool(
    "find_mailbox_folder",
    {
      description:
        "Find which real mailbox folder(s) an email belongs to. Required before move_email or delete_email when the email was found in a virtual folder (e.g., 'All Mail', 'Starred').",
      inputSchema: findMailboxFolderInput.shape,
    },
    async (args) => fromResult(await findMailboxFolder(deps.imapPool, args)),
  );

  server.registerTool(
    "list_emails",
    {
      description:
        "List emails in a mailbox with optional filters. Returns paginated metadata (read/unread, flagged, attachments, labels). Use get_email for full body content.",
      inputSchema: listEmailsInput.shape,
    },
    async (args) => fromResult(await listEmails(deps.imapPool, args)),
  );

  server.registerTool(
    "get_email",
    {
      description:
        "Get the full content of a specific email by UID. Does NOT mark it seen (BODY.PEEK). format=text strips HTML, format=stripped also drops quoted replies and signatures. Set markRead=true to flip \\Seen.",
      inputSchema: getEmailInput.shape,
    },
    async (args) => fromResult(await getEmail(deps.imapPool, args)),
  );

  server.registerTool(
    "get_emails",
    {
      description:
        "Fetch multiple emails in one call (max 20). More efficient than repeated get_email when triaging. Defaults to format=text. Does NOT mark seen.",
      inputSchema: getEmailsInput.shape,
    },
    async (args) => fromResult(await getEmails(deps.imapPool, args)),
  );

  server.registerTool(
    "move_email",
    {
      description:
        "Move an email to a different mailbox folder. sourceMailbox must be a real folder (not 'All Mail'). Use find_mailbox_folder if the email was discovered in a virtual folder.",
      inputSchema: moveEmailInput.shape,
    },
    async (args) => fromResult(await moveEmail(deps.imapPool, args)),
  );

  server.registerTool(
    "bulk_action",
    {
      description:
        "Batch operation on multiple emails by UID list. Supports mark_read, mark_unread, flag, unflag, move, delete. Max 100 UIDs.",
      inputSchema: bulkActionInput.shape,
    },
    async (args) => fromResult(await bulkAction(deps.imapPool, args)),
  );

  server.registerTool(
    "get_watcher_status",
    {
      description:
        "Status of the IMAP-to-Drive sync watcher: per-account/per-folder progress, last tick error, current sync state.",
      inputSchema: getWatcherStatusInput.shape,
    },
    async () => ok(getWatcherStatus(deps.watcher)),
  );
};

/**
 * MCP tool: list_accounts -- enumerate the configured email accounts.
 *
 * Read-only and config-driven; does not contact IMAP. Always call this
 * first to discover available account names for use with other tools.
 */

import { z } from "zod";
import type { Account } from "../config/schema.js";
import { isOAuthAccount } from "../config/schema.js";

export const listAccountsInput = z.object({}).strict();
export type ListAccountsInput = z.infer<typeof listAccountsInput>;

export type ListAccountsResult = {
  readonly accounts: ReadonlyArray<{
    readonly name: string;
    readonly email: string;
    readonly authType: "password" | "oauth";
    readonly fullName: string;
  }>;
};

export const listAccounts = (accounts: readonly Account[]): ListAccountsResult => ({
  accounts: accounts.map((a) => ({
    name: a.name,
    email: a.email,
    authType: isOAuthAccount(a) ? "oauth" : "password",
    fullName: a.full_name ?? a.email,
  })),
});

/**
 * Zod schemas for the TOML config file mounted at
 * `/home/mcp/.config/email-client-mcp/config.toml` by the assembler
 * (or wherever `EMAIL_CLIENT_MCP_CONFIG` points).
 *
 * Uses the canonical email vault account shape and adds [sdk] and [watcher]
 * sections specific to this server.
 */

import { z } from "zod";
import { sanitizeMailboxId } from "../store/conventions.js";

const DEFAULT_WATCHER_INTERVAL_MS = 300_000;

const imapSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(true),
  verify_ssl: z.boolean().default(false),
});

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
});

const passwordAccountSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  username: z.string().optional(),
  full_name: z.string().optional(),
  password: z.string().min(1),
  imap: imapSchema,
  smtp: smtpSchema.optional(),
});

const oauth2Schema = z.object({
  provider: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
});

const oauthAccountSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  username: z.string().optional(),
  full_name: z.string().optional(),
  oauth2: oauth2Schema,
  imap: imapSchema,
  smtp: smtpSchema.optional(),
});

export const accountSchema = z.union([passwordAccountSchema, oauthAccountSchema]);
export type Account = z.infer<typeof accountSchema>;
export type PasswordAccount = z.infer<typeof passwordAccountSchema>;
export type OAuthAccount = z.infer<typeof oauthAccountSchema>;
export type SmtpSettings = z.infer<typeof smtpSchema>;

export const isOAuthAccount = (a: Account): a is OAuthAccount => "oauth2" in a;

const bodyHydrationSchema = z.object({
  enabled: z.boolean().default(true),
  max_messages_per_tick: z.number().int().min(0).default(50),
  skip_all_mail: z.boolean().default(true),
});

const recentFirstSchema = z.object({
  enabled: z.boolean().default(true),
  initial_recent_window: z.number().int().min(1).default(1000),
  backfill_window_per_tick: z.number().int().min(0).default(500),
});

const watcherSchema = z.object({
  enabled: z.boolean().default(true),
  interval_ms: z.number().int().min(60_000).default(DEFAULT_WATCHER_INTERVAL_MS),
  folders: z.array(z.string()).optional(),
  flag_reconcile_window: z.number().int().min(0).default(500),
  body_hydration: bodyHydrationSchema.default({
    enabled: true,
    max_messages_per_tick: 50,
    skip_all_mail: true,
  }),
  recent_first: recentFirstSchema.default({
    enabled: true,
    initial_recent_window: 1000,
    backfill_window_per_tick: 500,
  }),
});

/**
 * Optional [sdk] block. The SDK's `APIS_API_KEY` / `APIS_BASE_URL` /
 * `APIS_WORKSPACE_ID` come from the spawned-pod env (injected by
 * mcp-hub k8s-gateway) on real deployments; the TOML overrides are
 * only useful for local development or unusual setups.
 */
const sdkSchema = z.object({
  api_key: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  workspace_id: z.string().optional(),
});

const deliverSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    rate_limit_per_account_per_minute: z.number().int().min(1),
  }),
]);

const accountsSchema = z
  .array(accountSchema)
  .min(1)
  .superRefine((accounts, context) => {
    const duplicateName = accounts.find(
      (account, index) =>
        accounts.findIndex((candidate) => candidate.name === account.name) !== index,
    );
    if (duplicateName !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate account name: ${duplicateName.name}`,
      });
    }

    const duplicateEmail = accounts.find((account, index) => {
      const email = account.email.trim().toLowerCase();
      return (
        accounts.findIndex((candidate) => candidate.email.trim().toLowerCase() === email) !== index
      );
    });
    if (duplicateEmail !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate account email: ${duplicateEmail.email.trim().toLowerCase()}`,
      });
    }

    const duplicateMailboxId = accounts.find((account, index) => {
      const mailboxId = sanitizeMailboxId(account.name);
      return (
        accounts.findIndex((candidate) => sanitizeMailboxId(candidate.name) === mailboxId) !== index
      );
    });
    if (duplicateMailboxId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `account name maps to duplicate mailbox id: ${sanitizeMailboxId(duplicateMailboxId.name)}`,
      });
    }
  });

export const configSchema = z
  .object({
    accounts: accountsSchema,
    sdk: sdkSchema.optional(),
    deliver: deliverSchema.default({ enabled: false }),
    watcher: watcherSchema.default({
      enabled: true,
      interval_ms: DEFAULT_WATCHER_INTERVAL_MS,
      flag_reconcile_window: 500,
      body_hydration: {
        enabled: true,
        max_messages_per_tick: 50,
        skip_all_mail: true,
      },
      recent_first: {
        enabled: true,
        initial_recent_window: 1000,
        backfill_window_per_tick: 500,
      },
    }),
  })
  .superRefine((config, context) => {
    if (!config.deliver.enabled) return;
    for (const [index, configuredAccount] of config.accounts.entries()) {
      if (configuredAccount.smtp !== undefined) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounts", index, "smtp"],
        message: `SMTP settings are required for delivery account: ${configuredAccount.name}`,
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type WatcherSettings = z.infer<typeof watcherSchema>;
export type SdkSettings = z.infer<typeof sdkSchema>;
export type DeliverSettings = z.infer<typeof deliverSchema>;

/**
 * Default config search path. Overridden by `EMAIL_CLIENT_MCP_CONFIG`.
 * Matches the MOUNT_PATH convention used by other diskd-ai assemblers
 * but resolves the user's home dir at startup so it works locally.
 */
export const defaultConfigPath = (homeDir: string): string =>
  `${homeDir}/.config/email-client-mcp/config.toml`;

/**
 * Zod schemas for the TOML config file mounted at
 * `/home/mcp/.config/email-client-mcp/config.toml` by the assembler
 * (or wherever `EMAIL_CLIENT_MCP_CONFIG` points).
 *
 * Mirrors the per-account shape used by `diskd-ai/email-mcp` so the same
 * vault accounts can serve both servers; adds [sdk] and [watcher]
 * sections specific to this server.
 */

import { z } from "zod";

const imapSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(true),
  verify_ssl: z.boolean().default(false),
});

const passwordAccountSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  username: z.string().optional(),
  full_name: z.string().optional(),
  password: z.string().min(1),
  imap: imapSchema,
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
  full_name: z.string().optional(),
  oauth2: oauth2Schema,
  imap: imapSchema,
});

export const accountSchema = z.union([passwordAccountSchema, oauthAccountSchema]);
export type Account = z.infer<typeof accountSchema>;
export type PasswordAccount = z.infer<typeof passwordAccountSchema>;
export type OAuthAccount = z.infer<typeof oauthAccountSchema>;

export const isOAuthAccount = (a: Account): a is OAuthAccount => "oauth2" in a;

const watcherSchema = z.object({
  enabled: z.boolean().default(true),
  interval_ms: z.number().int().min(60_000).default(60_000),
  folders: z.array(z.string()).optional(),
  flag_reconcile_window: z.number().int().min(0).default(500),
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

export const configSchema = z.object({
  accounts: z.array(accountSchema).min(1),
  sdk: sdkSchema.optional(),
  watcher: watcherSchema.default({
    enabled: true,
    interval_ms: 60_000,
    flag_reconcile_window: 500,
  }),
});

export type Config = z.infer<typeof configSchema>;
export type WatcherSettings = z.infer<typeof watcherSchema>;
export type SdkSettings = z.infer<typeof sdkSchema>;

/**
 * Default config search path. Overridden by `EMAIL_CLIENT_MCP_CONFIG`.
 * Matches the MOUNT_PATH convention used by other diskd-ai assemblers
 * but resolves the user's home dir at startup so it works locally.
 */
export const defaultConfigPath = (homeDir: string): string =>
  `${homeDir}/.config/email-client-mcp/config.toml`;

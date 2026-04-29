#!/usr/bin/env node
/**
 * email-client-mcp stdio entry. Composition root.
 *
 * Responsibilities:
 *  1. Parse CLI args (default subcommand: stdio).
 *  2. Load + validate the TOML config.
 *  3. Build @diskd-ai/sdk client and Drive store.
 *  4. Build IMAP pool + sync deps.
 *  5. Register MCP tools, attach stdio transport.
 *  6. Start the watcher AFTER the MCP `initialized` notification so we
 *     do not race with the client handshake -- per the email-mcp pattern.
 *  7. Graceful shutdown on SIGINT/SIGTERM.
 *
 * Logs go to stderr only (stdout is reserved for MCP JSON-RPC).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/loader.js";
import type { ImapError } from "./domain/errors.js";
import { errorMessage } from "./domain/errors.js";
import { Err, Ok, type Result } from "./domain/result.js";
import {
  fetchEnvelopesUidRange,
  fetchUidRange,
  folderStatus,
  withMailboxLock,
} from "./imap/fetch.js";
import { buildImapPool } from "./imap/pool.js";
import { buildDiskd } from "./sdk/diskdClient.js";
import { buildDriveStore } from "./store/driveStore.js";
import type { SyncDeps } from "./sync/sync.js";
import { buildWatcher } from "./sync/watcher.js";
import { registerTools } from "./tools/registry.js";

const log = (msg: string, extra?: Readonly<Record<string, unknown>>): void => {
  const payload = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(`[email-client-mcp] ${payload}\n`);
};

const parseSubcommand = (argv: readonly string[]): "stdio" | "unknown" => {
  // npx will pass the bin name as argv[1]; the user-supplied subcommand
  // is at argv[2] (or absent).
  const sub = argv[2];
  if (sub === undefined || sub === "stdio") return "stdio";
  return "unknown";
};

const main = async (): Promise<void> => {
  const sub = parseSubcommand(process.argv);
  if (sub === "unknown") {
    log("usage: email-client-mcp [stdio]");
    process.exit(2);
  }

  const configPath = process.env.EMAIL_CLIENT_MCP_CONFIG;
  const cfg = await loadConfig(configPath);
  if (cfg.tag === "Err") {
    log("config error", { error: errorMessage(cfg.error) });
    process.exit(1);
  }

  const diskd = buildDiskd(cfg.value.sdk, process.env.MCP_HUB_WORKSPACE_ID);
  if (diskd.tag === "Err") {
    log("sdk init failed", { error: errorMessage(diskd.error) });
    process.exit(1);
  }
  log("sdk ready", { workspaceId: diskd.value.workspaceId });
  const driveStore = buildDriveStore(diskd.value.messagesStore);

  const pool = buildImapPool(cfg.value.accounts, {
    onEvent: (event) => log("imap.pool-event", event),
  });

  const syncDeps: SyncDeps = {
    drive: driveStore as unknown as SyncDeps["drive"],
    imap: {
      listFolders: async (accountId) => {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") return c;
        try {
          const list = await c.value.list();
          return Ok(
            list.map((f) => ({
              path: f.path,
              specialUse: (f.specialUse ?? null) as string | null,
            })),
          );
        } catch (cause) {
          return Err({
            kind: "ImapError",
            accountId,
            message: `list failed: ${(cause as Error)?.message ?? String(cause)}`,
          } as ImapError);
        }
      },
      folderStatus: async (accountId, path) => {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") return c;
        try {
          const s = await folderStatus(c.value, path);
          return Ok(s) as Result<
            ImapError,
            { uidValidity: number; uidNext: number; messages: number }
          >;
        } catch (cause) {
          return Err({
            kind: "ImapError",
            accountId,
            message: `status ${path}: ${(cause as Error)?.message ?? String(cause)}`,
          } as ImapError);
        }
      },
      fetchRange: async function* (accountId, path, fromUid, toUid) {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") throw new Error(errorMessage(c.error));
        // Buffer under-lock, yield after release. Batch sizes are
        // bounded (sync uses 50) so the cost is acceptable.
        const buf = await withMailboxLock(c.value, path, async () => {
          const out: unknown[] = [];
          for await (const m of fetchUidRange(c.value, fromUid, toUid)) out.push(m);
          return out;
        });
        for (const m of buf) yield m as never;
      },
      fetchEnvelopesRange: async function* (accountId, path, fromUid, toUid) {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") throw new Error(errorMessage(c.error));
        const buf = await withMailboxLock(c.value, path, async () => {
          const out: unknown[] = [];
          for await (const m of fetchEnvelopesUidRange(c.value, fromUid, toUid)) out.push(m);
          return out;
        });
        for (const m of buf) yield m as never;
      },
    },
    now: () => new Date(),
  };

  const watcher = buildWatcher(syncDeps, cfg.value.accounts, cfg.value.watcher, log);

  const server = new McpServer({
    name: "email-client-mcp",
    version: "0.1.0",
  });

  registerTools(server, {
    accounts: cfg.value.accounts,
    imapPool: pool,
    watcher,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("mcp ready", { accounts: cfg.value.accounts.length });

  // Start watcher after MCP transport is ready. The interval fires
  // immediately on the first tick (see watcher.start), then on every
  // clamped interval thereafter.
  if (cfg.value.watcher.enabled) {
    watcher.start();
  } else {
    log("watcher.disabled-by-config");
  }

  const shutdown = async (signal: string): Promise<void> => {
    log("shutdown", { signal });
    try {
      await watcher.stop();
    } catch (e) {
      log("watcher stop error", { error: String(e) });
    }
    try {
      await pool.closeAll();
    } catch (e) {
      log("pool close error", { error: String(e) });
    }
    try {
      await server.close();
    } catch (e) {
      log("server close error", { error: String(e) });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((err) => {
  log("fatal", { error: (err as Error)?.message ?? String(err) });
  process.exit(1);
});

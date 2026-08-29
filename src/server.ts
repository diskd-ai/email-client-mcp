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

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/loader.js";
import {
  buildDeliveryProcessor,
  type DeliveryProcessor,
} from "./delivery/infrastructure/deliveryProcessor.js";
import {
  type ExchangeDeliveryProtocol,
  registerExchangeDeliveryHandler,
} from "./delivery/infrastructure/deliveryProtocol.js";
import {
  buildDeliveryRuntime,
  type DeliveryRuntime,
} from "./delivery/infrastructure/deliveryRuntime.js";
import { buildDriveAttachmentLoader } from "./delivery/infrastructure/driveAttachmentLoader.js";
import { buildOutboxRepository } from "./delivery/infrastructure/outboxSdkAdapter.js";
import { buildPerAccountRateLimiter } from "./delivery/infrastructure/perAccountRateLimiter.js";
import { buildSentFolderAppender } from "./delivery/infrastructure/sentFolderAppender.js";
import { buildSmtpSender, type SmtpSender } from "./delivery/infrastructure/smtpTransport.js";
import type { ImapError } from "./domain/errors.js";
import { errorMessage } from "./domain/errors.js";
import { Err, Ok, type Result } from "./domain/result.js";
import { configureServerMode, parseSubcommand } from "./entrypointMode.js";
import { buildPlatformEventNotifier } from "./events/platformEventNotifier.js";
import {
  downloadPartByUid,
  fetchDisplayBodyByUid,
  fetchEnvelopesUidRange,
  fetchMetadataUidRange,
  folderStatus,
  withMailboxLock,
} from "./imap/fetch.js";
import { buildImapPool } from "./imap/pool.js";
import { buildDiskd } from "./sdk/diskdClient.js";
import { buildDriveStore } from "./store/driveStore.js";
import {
  type AttachmentHydrationDeps,
  DEFAULT_ATTACHMENT_HYDRATION_TIMEOUT_MS,
} from "./sync/attachmentHydration.js";
import type { BodyHydrationDeps } from "./sync/bodyHydration.js";
import type { SyncDeps } from "./sync/sync.js";
import { buildWatcher } from "./sync/watcher.js";
import { registerTools } from "./tools/registry.js";
import { PACKAGE_VERSION } from "./version.js";

const log = (msg: string, extra?: Readonly<Record<string, unknown>>): void => {
  const payload = extra === undefined ? msg : `${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(`[email-client-mcp] ${payload}\n`);
};

const main = async (): Promise<void> => {
  const mode = parseSubcommand(process.argv);
  if (mode === "unknown") {
    log("usage: email-client-mcp [stdio|deliver]");
    process.exit(2);
  }

  log("starting", { version: PACKAGE_VERSION, mode });

  const configPath = process.env.EMAIL_CLIENT_MCP_CONFIG;
  const cfg = await loadConfig(configPath);
  if (cfg.tag === "Err") {
    log("config error", { error: errorMessage(cfg.error) });
    process.exit(1);
  }
  if (mode === "deliver" && !cfg.value.deliver.enabled) {
    log("config error", { error: "deliver mode requires [deliver].enabled = true" });
    process.exit(1);
  }

  const diskd = buildDiskd(cfg.value.sdk, process.env.MCP_HUB_WORKSPACE_ID);
  if (diskd.tag === "Err") {
    log("sdk init failed", { error: errorMessage(diskd.error) });
    process.exit(1);
  }
  log("sdk ready", { workspaceId: diskd.value.workspaceId });
  const driveStore = buildDriveStore(diskd.value.messagesStore);

  const server = new McpServer({
    name: "email-client-mcp",
    version: PACKAGE_VERSION,
  });
  const platformEvents = buildPlatformEventNotifier(server, diskd.value.workspaceId);

  const pool = buildImapPool(cfg.value.accounts, {
    onEvent: (event) => log("imap.pool-event", event),
  });

  const notifier: SyncDeps["notifier"] = {
    notifyEmailPersisted: platformEvents.notifyExchangeInboxCreated,
  };

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
              delimiter: f.delimiter,
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
      fetchMetadataRange: async function* (accountId, path, fromUid, toUid) {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") throw new Error(errorMessage(c.error));
        // Buffer under-lock, yield after release. Batch sizes are
        // bounded (sync uses 50) so the cost is acceptable.
        const buf = await withMailboxLock(c.value, path, async () => {
          const out: unknown[] = [];
          for await (const m of fetchMetadataUidRange(c.value, fromUid, toUid)) out.push(m);
          return out;
        });
        for (const m of buf) yield m as never;
      },
      fetchBody: async (accountId, path, uid) => {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") return c;
        try {
          const body = await withMailboxLock(c.value, path, async () =>
            fetchDisplayBodyByUid(c.value, uid),
          );
          return Ok(body);
        } catch (cause) {
          return Err({
            kind: "ImapError",
            accountId,
            message: `fetch body ${path}/${uid}: ${(cause as Error)?.message ?? String(cause)}`,
            cause,
          } as ImapError);
        }
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
      downloadPart: async (accountId, path, uid, partId) => {
        const c = await pool.forAccount(accountId);
        if (c.tag === "Err") throw new Error(errorMessage(c.error));
        return await downloadPartByUid(c.value, path, uid, partId, {
          timeoutMs: DEFAULT_ATTACHMENT_HYDRATION_TIMEOUT_MS,
        });
      },
    },
    now: () => new Date(),
    log,
    notifier,
  };

  const bodyHydrationDeps: BodyHydrationDeps = {
    drive: driveStore as unknown as BodyHydrationDeps["drive"],
    imap: { fetchBody: syncDeps.imap.fetchBody },
    now: () => new Date(),
  };
  const attachmentHydrationDeps: AttachmentHydrationDeps = {
    drive: driveStore as unknown as AttachmentHydrationDeps["drive"],
    imap: { downloadPart: syncDeps.imap.downloadPart },
  };

  const watcher = buildWatcher(syncDeps, cfg.value.accounts, cfg.value.watcher, log);
  const smtpSenders: SmtpSender[] = [];
  let deliveryRuntime: DeliveryRuntime | undefined;
  let deliveryProcessor: DeliveryProcessor | undefined;
  let requestShutdown: (signal: string, exitCode: number) => void = (signal, exitCode) => {
    log("shutdown requested before runtime initialization", { signal, exitCode });
    process.exitCode = exitCode;
  };
  if (cfg.value.deliver.enabled) {
    const deliveryAccounts = cfg.value.accounts.map((account) => {
      const sender = buildSmtpSender(account);
      smtpSenders.push(sender);
      return { config: account, sender };
    });
    const repository = buildOutboxRepository(diskd.value.messagesStore);
    deliveryProcessor = buildDeliveryProcessor({
      repository,
      accounts: deliveryAccounts,
      rateLimiter: buildPerAccountRateLimiter(cfg.value.deliver.rate_limit_per_account_per_minute),
      leaseOwner: `email-client-mcp-${randomUUID()}`,
      now: () => new Date(),
      log,
      attachmentLoader: buildDriveAttachmentLoader(diskd.value.drive),
      sentFolderAppender: buildSentFolderAppender(pool),
    });
    deliveryRuntime = buildDeliveryRuntime({
      repository,
      processor: deliveryProcessor,
      log,
    });
  }

  const registerModelTools = (): void =>
    registerTools(server, {
      accounts: cfg.value.accounts,
      imapPool: pool,
      watcher,
      bodyHydration: bodyHydrationDeps,
      attachmentHydration: attachmentHydrationDeps,
      messageMirror: driveStore,
    });

  if (deliveryProcessor === undefined) {
    if (mode === "stdio") registerModelTools();
  } else {
    configureServerMode(mode, {
      registerDelivery: () =>
        registerExchangeDeliveryHandler(
          server.server as unknown as ExchangeDeliveryProtocol,
          deliveryProcessor,
        ),
      registerTools: registerModelTools,
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("mcp ready", { accounts: cfg.value.accounts.length, mode });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    log("shutdown", { signal, exitCode });
    if (deliveryRuntime !== undefined) {
      try {
        await deliveryRuntime.stop();
      } catch (e) {
        log("delivery stop error", { error: String(e) });
      }
    }
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
    for (const sender of smtpSenders) {
      try {
        sender.close();
      } catch (e) {
        log("smtp close error", { error: String(e) });
      }
    }
    try {
      await server.close();
    } catch (e) {
      log("server close error", { error: String(e) });
    }
    process.exit(exitCode);
  };
  requestShutdown = (signal, exitCode) => {
    if (shutdownPromise !== undefined) return;
    shutdownPromise = shutdown(signal, exitCode).catch((cause) => {
      log("shutdown failed", { error: cause instanceof Error ? cause.message : String(cause) });
      process.exit(1);
    });
  };
  process.on("SIGINT", () => requestShutdown("SIGINT", 0));
  process.on("SIGTERM", () => requestShutdown("SIGTERM", 0));

  if (deliveryRuntime !== undefined) {
    await deliveryRuntime.start();
  } else {
    log("delivery.disabled-by-config");
  }

  // Start watcher after MCP transport is ready. The interval fires
  // immediately on the first tick (see watcher.start), then on every
  // clamped interval thereafter.
  if (mode === "stdio" && cfg.value.watcher.enabled) {
    watcher.start();
  } else {
    log("watcher.disabled", {
      reason: mode === "deliver" ? "deliver-mode" : "config",
    });
  }
};

main().catch((err) => {
  log("fatal", { error: (err as Error)?.message ?? String(err) });
  process.exit(1);
});

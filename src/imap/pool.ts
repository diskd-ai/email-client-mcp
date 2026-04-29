/**
 * Per-account `ImapFlow` connection cache.
 *
 * Reliability properties:
 *  - Connections are created lazily and reused across tool calls and
 *    sync ticks. Lock acquisition (per imapflow's getMailboxLock) is
 *    the only way folder operations occur, so two concurrent callers
 *    can share one socket without races.
 *  - On a connection that has dropped (`usable === false`), the next
 *    `forAccount(...)` call rebuilds it.
 *  - Every `ImapFlow` client has an `error` listener. Socket timeouts
 *    evict only that account's client and throttle reconnect by 30s
 *    instead of becoming an unhandled process-level event.
 *  - OAuth refresh: Gmail/Microsoft refresh tokens are exchanged for
 *    short-lived access tokens before ImapFlow receives XOAUTH2 auth.
 */

import { ImapFlow } from "imapflow";
import { type Account, isOAuthAccount } from "../config/schema.js";
import { type ImapError, imapError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { type OAuthTokenFetcher, refreshOAuthAccessToken } from "./oauth.js";

const DEFAULT_RECONNECT_DELAY_MS = 30_000;

export type ImapPoolEvent =
  | {
      readonly kind: "clientError";
      readonly accountId: string;
      readonly message: string;
      readonly reconnectDelayMs: number;
    }
  | {
      readonly kind: "clientClosed";
      readonly accountId: string;
    }
  | {
      readonly kind: "closeError";
      readonly accountId: string;
      readonly phase: "evict" | "shutdown";
      readonly message: string;
    }
  | {
      readonly kind: "reconnectDelayed";
      readonly accountId: string;
      readonly delayMs: number;
    };

export type ImapPoolOptions = {
  readonly reconnectDelayMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onEvent?: (event: ImapPoolEvent) => void;
  readonly fetchOAuthToken?: OAuthTokenFetcher;
  readonly createClient?: (account: Account, auth: ImapAuth) => ImapFlow;
};

export type ImapPool = {
  readonly forAccount: (accountId: string) => Promise<Result<ImapError, ImapFlow>>;
  readonly closeAll: () => Promise<void>;
  readonly accountIds: readonly string[];
};

export type ImapAuth =
  | {
      readonly user: string;
      readonly pass: string;
    }
  | {
      readonly user: string;
      readonly accessToken: string;
    };

const buildClient = (acct: Account, auth: ImapAuth): ImapFlow => {
  if (isOAuthAccount(acct)) {
    return new ImapFlow({
      host: acct.imap.host,
      port: acct.imap.port,
      secure: acct.imap.tls,
      tls: { rejectUnauthorized: acct.imap.verify_ssl },
      auth,
      logger: false,
    });
  }
  return new ImapFlow({
    host: acct.imap.host,
    port: acct.imap.port,
    secure: acct.imap.tls,
    tls: { rejectUnauthorized: acct.imap.verify_ssl },
    auth,
    logger: false,
  });
};

const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const resolveAuth = async (
  acct: Account,
  fetchOAuthToken: OAuthTokenFetcher,
): Promise<Result<ImapError, ImapAuth>> => {
  if (!isOAuthAccount(acct)) {
    return Ok({ user: acct.username ?? acct.email, pass: acct.password });
  }

  const token = await fetchOAuthToken(acct);
  if (token.tag === "Err") return token;
  return Ok({ user: acct.username ?? acct.email, accessToken: token.value });
};

export const buildImapPool = (
  accounts: readonly Account[],
  options: ImapPoolOptions = {},
): ImapPool => {
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const createClient = options.createClient ?? buildClient;
  const fetchOAuthToken = options.fetchOAuthToken ?? refreshOAuthAccessToken;
  const byId = new Map<string, Account>();
  for (const a of accounts) byId.set(a.name, a);
  const liveById = new Map<string, ImapFlow>();
  const reconnectAfterById = new Map<string, number>();
  const connectingById = new Map<string, Promise<Result<ImapError, ImapFlow>>>();

  const emitEvent = (event: ImapPoolEvent): void => {
    options.onEvent?.(event);
  };

  const delayReconnect = (accountId: string): void => {
    reconnectAfterById.set(accountId, nowMs() + reconnectDelayMs);
  };

  const waitForReconnectWindow = async (accountId: string): Promise<void> => {
    const reconnectAfter = reconnectAfterById.get(accountId);
    if (reconnectAfter === undefined) return;
    const delayMs = reconnectAfter - nowMs();
    if (delayMs <= 0) {
      reconnectAfterById.delete(accountId);
      return;
    }
    emitEvent({ kind: "reconnectDelayed", accountId, delayMs });
    await sleep(delayMs);
    if (reconnectAfterById.get(accountId) === reconnectAfter) {
      reconnectAfterById.delete(accountId);
    }
  };

  const closeClient = (accountId: string, client: ImapFlow, phase: "evict" | "shutdown"): void => {
    try {
      client.close();
    } catch (cause) {
      emitEvent({ kind: "closeError", accountId, phase, message: toErrorMessage(cause) });
    }
  };

  const attachLifecycleHandlers = (accountId: string, client: ImapFlow): void => {
    client.on("error", (error) => {
      if (liveById.get(accountId) === client) liveById.delete(accountId);
      delayReconnect(accountId);
      emitEvent({
        kind: "clientError",
        accountId,
        message: toErrorMessage(error),
        reconnectDelayMs,
      });
      closeClient(accountId, client, "evict");
    });
    client.on("close", () => {
      if (liveById.get(accountId) === client) liveById.delete(accountId);
      emitEvent({ kind: "clientClosed", accountId });
    });
  };

  const forAccount = async (accountId: string): Promise<Result<ImapError, ImapFlow>> => {
    const acct = byId.get(accountId);
    if (!acct) return Err(imapError(accountId, "unknown account id"));
    const cached = liveById.get(accountId);
    if (cached?.usable) return Ok(cached);
    if (cached && !cached.usable) {
      liveById.delete(accountId);
      closeClient(accountId, cached, "evict");
    }

    const connecting = connectingById.get(accountId);
    if (connecting !== undefined) return await connecting;

    const connectFresh = async (): Promise<Result<ImapError, ImapFlow>> => {
      await waitForReconnectWindow(accountId);
      const auth = await resolveAuth(acct, fetchOAuthToken);
      if (auth.tag === "Err") {
        delayReconnect(accountId);
        return auth;
      }
      const client = createClient(acct, auth.value);
      attachLifecycleHandlers(accountId, client);
      try {
        await client.connect();
      } catch (cause) {
        delayReconnect(accountId);
        closeClient(accountId, client, "evict");
        return Err(imapError(accountId, `connect failed: ${toErrorMessage(cause)}`, cause));
      }
      reconnectAfterById.delete(accountId);
      liveById.set(accountId, client);
      return Ok(client);
    };

    const pending = connectFresh();
    connectingById.set(accountId, pending);
    try {
      return await pending;
    } finally {
      connectingById.delete(accountId);
    }
  };

  const closeAll = async (): Promise<void> => {
    const closes = Array.from(liveById.entries()).map(async ([accountId, client]) => {
      try {
        await client.logout();
      } catch (cause) {
        emitEvent({
          kind: "closeError",
          accountId,
          phase: "shutdown",
          message: toErrorMessage(cause),
        });
        closeClient(accountId, client, "shutdown");
      }
    });
    await Promise.all(closes);
    liveById.clear();
    reconnectAfterById.clear();
  };

  return { forAccount, closeAll, accountIds: Array.from(byId.keys()) };
};

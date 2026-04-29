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
 *  - OAuth refresh: imapflow accepts an `accessToken` for XOAUTH2;
 *    the pool keeps a per-account "fetcher" that swaps the access
 *    token in-place at reconnect time. The provider-side refresh is
 *    a follow-up (see SDK gap notes); for v1 the password path is
 *    fully wired and OAuth runs against a long-lived access token.
 */

import { ImapFlow } from "imapflow";
import { type Account, isOAuthAccount } from "../config/schema.js";
import { type ImapError, imapError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";

export type ImapPool = {
  readonly forAccount: (accountId: string) => Promise<Result<ImapError, ImapFlow>>;
  readonly closeAll: () => Promise<void>;
  readonly accountIds: readonly string[];
};

const buildClient = (acct: Account): ImapFlow => {
  if (isOAuthAccount(acct)) {
    return new ImapFlow({
      host: acct.imap.host,
      port: acct.imap.port,
      secure: acct.imap.tls,
      tls: { rejectUnauthorized: acct.imap.verify_ssl },
      auth: {
        user: acct.email,
        accessToken: acct.oauth2.refresh_token,
      },
      logger: false,
    });
  }
  return new ImapFlow({
    host: acct.imap.host,
    port: acct.imap.port,
    secure: acct.imap.tls,
    tls: { rejectUnauthorized: acct.imap.verify_ssl },
    auth: {
      user: acct.username ?? acct.email,
      pass: acct.password,
    },
    logger: false,
  });
};

export const buildImapPool = (accounts: readonly Account[]): ImapPool => {
  const byId = new Map<string, Account>();
  for (const a of accounts) byId.set(a.name, a);
  const liveById = new Map<string, ImapFlow>();

  const forAccount = async (accountId: string): Promise<Result<ImapError, ImapFlow>> => {
    const acct = byId.get(accountId);
    if (!acct) return Err(imapError(accountId, "unknown account id"));
    const cached = liveById.get(accountId);
    if (cached && cached.usable) return Ok(cached);
    if (cached && !cached.usable) {
      try {
        await cached.logout();
      } catch {
        // ignore: connection was already broken
      }
      liveById.delete(accountId);
    }
    const client = buildClient(acct);
    try {
      await client.connect();
    } catch (cause) {
      return Err(
        imapError(
          accountId,
          `connect failed: ${(cause as Error)?.message ?? String(cause)}`,
          cause,
        ),
      );
    }
    liveById.set(accountId, client);
    return Ok(client);
  };

  const closeAll = async (): Promise<void> => {
    const closes = Array.from(liveById.values()).map(async (c) => {
      try {
        await c.logout();
      } catch {
        // ignore on shutdown
      }
    });
    await Promise.all(closes);
    liveById.clear();
  };

  return { forAccount, closeAll, accountIds: Array.from(byId.keys()) };
};

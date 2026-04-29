/**
 * Interval-based watcher.
 *
 * Reliability properties:
 *  - Per-account in-flight lock: a tick that runs longer than the
 *    interval will not be doubled-up. The next interval simply skips
 *    the busy account (logged) -- it never queues.
 *  - Hard floor of `MIN_TICK_INTERVAL_MS` per spec ("no more often
 *    than 1 minute"). Configured intervals below the floor are clamped.
 *  - Status snapshot exposes per-account / per-folder progress for
 *    `get_watcher_status`.
 *  - Errors are caught at the per-account boundary and recorded into
 *    the snapshot; one bad account does not stop the others.
 */

import type { Account, WatcherSettings } from "../config/schema.js";
import { clampTickInterval } from "./backoff.js";
import { runSyncOnce, type SyncDeps, type SyncReport } from "./sync.js";

export type WatcherFolderStatus = {
  readonly folderId: string;
  readonly newMessages: number;
  readonly reconciledFlags: number;
  readonly uidValidityRolled: boolean;
  readonly error: string | null;
};

export type WatcherAccountStatus = {
  readonly accountId: string;
  readonly currentlySyncing: boolean;
  readonly lastTickStartedAt: string | null;
  readonly lastTickFinishedAt: string | null;
  readonly lastTickError: string | null;
  readonly folders: readonly WatcherFolderStatus[];
};

export type WatcherStatus = {
  readonly running: boolean;
  readonly intervalMs: number;
  readonly accounts: readonly WatcherAccountStatus[];
};

export type Watcher = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly status: () => WatcherStatus;
  readonly runOnceNow: (accountId?: string) => Promise<readonly SyncReport[]>;
};

const reportToStatus = (rep: SyncReport): WatcherAccountStatus => ({
  accountId: rep.accountId,
  currentlySyncing: false,
  lastTickStartedAt: rep.startedAt,
  lastTickFinishedAt: rep.finishedAt,
  lastTickError: rep.error,
  folders: rep.folders.map((f) => ({
    folderId: f.folderId,
    newMessages: f.newMessages,
    reconciledFlags: f.reconciledFlags,
    uidValidityRolled: f.uidValidityRolled,
    error: f.error,
  })),
});

export const buildWatcher = (
  deps: SyncDeps,
  accounts: readonly Account[],
  watcher: WatcherSettings,
  log: (msg: string, extra?: Readonly<Record<string, unknown>>) => void,
): Watcher => {
  const intervalMs = clampTickInterval(watcher.interval_ms);
  const inFlight = new Map<string, Promise<SyncReport>>();
  const lastStatus = new Map<string, WatcherAccountStatus>();
  for (const a of accounts) {
    lastStatus.set(a.name, {
      accountId: a.name,
      currentlySyncing: false,
      lastTickStartedAt: null,
      lastTickFinishedAt: null,
      lastTickError: null,
      folders: [],
    });
  }
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const runTick = (): void => {
    void tick().catch((cause) => {
      const msg = (cause as Error)?.message ?? String(cause);
      log("watcher.tick-unhandled", { error: msg });
    });
  };

  const runForAccount = async (acct: Account): Promise<SyncReport> => {
    const existing = inFlight.get(acct.name);
    if (existing !== undefined) {
      log("watcher.skip-overlap", { accountId: acct.name });
      return existing;
    }
    const cur = lastStatus.get(acct.name);
    if (cur !== undefined) {
      lastStatus.set(acct.name, { ...cur, currentlySyncing: true });
    }
    const p = (async () => {
      try {
        const rep = await runSyncOnce(deps, acct, watcher);
        lastStatus.set(acct.name, reportToStatus(rep));
        if (rep.error !== null) log("watcher.tick-err", { accountId: acct.name, error: rep.error });
        else
          log("watcher.tick-ok", {
            accountId: acct.name,
            folders: rep.folders.length,
            newMessages: rep.folders.reduce((s, f) => s + f.newMessages, 0),
          });
        return rep;
      } catch (cause) {
        const msg = (cause as Error)?.message ?? String(cause);
        const finishedAt = deps.now().toISOString();
        const rep: SyncReport = {
          accountId: acct.name,
          folders: [],
          prunedFolders: 0,
          startedAt: cur?.lastTickStartedAt ?? finishedAt,
          finishedAt,
          error: msg,
        };
        lastStatus.set(acct.name, reportToStatus(rep));
        log("watcher.tick-throw", { accountId: acct.name, error: msg });
        return rep;
      }
    })();
    inFlight.set(acct.name, p);
    try {
      return await p;
    } finally {
      inFlight.delete(acct.name);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Run all accounts in parallel; in-flight lock per account makes overlap safe.
    const work = accounts.map((a) => runForAccount(a));
    await Promise.all(work);
  };

  const start = (): void => {
    if (timer !== null) return;
    if (!watcher.enabled) {
      log("watcher.disabled");
      return;
    }
    log("watcher.start", { intervalMs, accounts: accounts.map((a) => a.name) });
    // Fire one tick immediately on boot so first sync does not wait a full interval.
    runTick();
    timer = setInterval(() => {
      runTick();
    }, intervalMs);
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // Wait for any in-flight ticks so we never tear state down mid-batch.
    await Promise.all(Array.from(inFlight.values()));
  };

  const status = (): WatcherStatus => ({
    running: timer !== null,
    intervalMs,
    accounts: Array.from(lastStatus.values()),
  });

  const runOnceNow = async (accountId?: string): Promise<readonly SyncReport[]> => {
    if (accountId !== undefined) {
      const acct = accounts.find((a) => a.name === accountId);
      if (acct === undefined) return [];
      return [await runForAccount(acct)];
    }
    return await Promise.all(accounts.map((a) => runForAccount(a)));
  };

  return { start, stop, status, runOnceNow };
};

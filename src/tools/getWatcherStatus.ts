/**
 * MCP tool: get_watcher_status -- in-memory status snapshot from the
 * sync watcher. Read-only; no IMAP / Drive contact.
 */

import { z } from "zod";
import type { Watcher, WatcherStatus } from "../sync/watcher.js";

export const getWatcherStatusInput = z.object({}).strict();
export type GetWatcherStatusInput = z.infer<typeof getWatcherStatusInput>;

export const getWatcherStatus = (watcher: Watcher): WatcherStatus => watcher.status();

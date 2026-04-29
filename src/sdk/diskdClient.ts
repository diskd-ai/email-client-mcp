/**
 * Build the @diskd-ai/sdk client used by the drive-backed messages store.
 *
 * Credential resolution (each independently):
 *   workspaceId  := TOML [sdk].workspace_id
 *                 | env APIS_WORKSPACE_ID    (injected by mcp-hub k8s-gateway)
 *                 | env MCP_HUB_WORKSPACE_ID (legacy, also from k8s-gateway)
 *   APIS_API_KEY := env APIS_API_KEY (mcp-hub injects from cluster Secret)
 *                 | TOML [sdk].api_key (lower precedence; only fills if env empty)
 *   APIS_BASE_URL := env APIS_BASE_URL
 *                 | TOML [sdk].base_url
 *
 * SDK constraint (5.1.x): `APIS_API_KEY` and `APIS_BASE_URL` are read
 * from `process.env` only -- there is no constructor param. We mirror
 * TOML values into env via `ensureEnv` (only when env is empty) so cluster
 * env always wins over per-server TOML.
 */

import { diskd } from "@diskd-ai/sdk";
import type { SdkSettings } from "../config/schema.js";
import { type ConfigError, configError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";

export type DiskdRuntime = {
  readonly workspaceId: string;
  readonly messagesStore: ReturnType<typeof diskd.os.messagesStore>;
};

const ensureEnv = (key: string, value: string): void => {
  const current = process.env[key];
  if (current === undefined || current.length === 0) {
    process.env[key] = value;
  }
};

const readEnv = (key: string): string | undefined => {
  const v = process.env[key];
  return v !== undefined && v.length > 0 ? v : undefined;
};

export const buildDiskd = (
  sdkSettings: SdkSettings | undefined,
  envWorkspaceId: string | undefined,
): Result<ConfigError, DiskdRuntime> => {
  // workspaceId: TOML > APIS_WORKSPACE_ID > MCP_HUB_WORKSPACE_ID.
  const workspaceId =
    sdkSettings?.workspace_id ?? readEnv("APIS_WORKSPACE_ID") ?? envWorkspaceId;
  if (workspaceId === undefined || workspaceId.length === 0) {
    return Err(
      configError(
        "workspace_id is missing -- expected APIS_WORKSPACE_ID or MCP_HUB_WORKSPACE_ID env (set by mcp-hub k8s-gateway), or [sdk].workspace_id in TOML",
      ),
    );
  }

  // Mirror TOML values into env only when env is empty so cluster
  // injection (mcp-hub specs.ts) always wins.
  if (sdkSettings?.api_key) ensureEnv("APIS_API_KEY", sdkSettings.api_key);
  if (sdkSettings?.base_url) ensureEnv("APIS_BASE_URL", sdkSettings.base_url);

  if (readEnv("APIS_BASE_URL") === undefined) {
    return Err(
      configError(
        "APIS_BASE_URL is not set -- expected env from mcp-hub k8s-gateway, or [sdk].base_url in TOML",
      ),
    );
  }
  if (readEnv("APIS_API_KEY") === undefined) {
    return Err(
      configError(
        "APIS_API_KEY is not set -- expected env from mcp-hub k8s-gateway, or [sdk].api_key in TOML",
      ),
    );
  }

  const auth = diskd.auth.apiKey({ workspaceId });
  const messagesStore = diskd.os.messagesStore({ auth });
  return Ok({ workspaceId, messagesStore });
};

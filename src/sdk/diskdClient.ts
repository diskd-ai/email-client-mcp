/**
 * Build the @diskd/sdk client used by the drive-backed messages store.
 *
 * SDK constraint observed in 5.1.x: `APIS_API_KEY` and `APIS_BASE_URL`
 * are read from `process.env` only -- there is no constructor param.
 * We therefore copy the TOML `[sdk]` block into env *before* calling
 * `diskd.auth.apiKey()`. This is a small SDK gap (would prefer explicit
 * params); documented in the design plan and called out here.
 *
 * Workspace id falls back to `MCP_HUB_WORKSPACE_ID` (injected by mcp-hub
 * k8s-gateway specs) so deployments don't have to encode workspaceId twice.
 */

import { diskd } from "@diskd/sdk";
import type { SdkSettings } from "../config/schema.js";
import { type ConfigError, configError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";

export type DiskdRuntime = {
  readonly workspaceId: string;
  readonly messagesStore: ReturnType<typeof diskd.os.messagesStore>;
};

const ensureEnv = (key: string, value: string): void => {
  // Only set if unset, so an explicit env value (e.g. from mcp-hub) wins
  // over the TOML when present.
  const current = process.env[key];
  if (current === undefined || current.length === 0) {
    process.env[key] = value;
  }
};

export const buildDiskd = (
  sdkSettings: SdkSettings,
  envWorkspaceId: string | undefined,
): Result<ConfigError, DiskdRuntime> => {
  const workspaceId = sdkSettings.workspace_id ?? envWorkspaceId;
  if (workspaceId === undefined || workspaceId.length === 0) {
    return Err(
      configError(
        "workspace_id is missing -- set [sdk].workspace_id in TOML or MCP_HUB_WORKSPACE_ID in env",
      ),
    );
  }

  ensureEnv("APIS_API_KEY", sdkSettings.api_key);
  if (sdkSettings.base_url) ensureEnv("APIS_BASE_URL", sdkSettings.base_url);
  if (process.env.APIS_BASE_URL === undefined || process.env.APIS_BASE_URL.length === 0) {
    return Err(
      configError(
        "APIS_BASE_URL is not set -- provide [sdk].base_url in TOML or APIS_BASE_URL in env",
      ),
    );
  }

  const auth = diskd.auth.apiKey({ workspaceId });
  const messagesStore = diskd.os.messagesStore({ auth });
  return Ok({ workspaceId, messagesStore });
};

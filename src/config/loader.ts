/**
 * Read and validate the server's TOML config file. Pure adapter:
 * exceptions from fs/parse are converted to typed `ConfigError`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { type ConfigError, configError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import { type Config, configSchema, defaultConfigPath } from "./schema.js";

const resolveConfigPath = (override: string | undefined): string => {
  if (override !== undefined && override.length > 0) return override;
  return defaultConfigPath(homedir());
};

/**
 * Load + validate the TOML config. Returns `Result.Err(ConfigError)`
 * for: file missing, invalid TOML, schema mismatch.
 */
export const loadConfig = async (
  override?: string | undefined,
): Promise<Result<ConfigError, Config>> => {
  const path = resolveConfigPath(override);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    return Err(configError(`could not read config at ${path}`, cause));
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (cause) {
    return Err(configError(`invalid TOML at ${path}`, cause));
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    return Err(configError(`config at ${path} failed schema validation: ${result.error.message}`));
  }
  return Ok(result.data);
};

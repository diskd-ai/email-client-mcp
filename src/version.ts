import { readFileSync } from "node:fs";

type PackageMetadata = {
  readonly version: string;
};

const packageJsonUrl = new URL("../package.json", import.meta.url);

/** Verifies package metadata contains the published package version. */
function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const versionDescriptor = Object.getOwnPropertyDescriptor(value, "version");
  return typeof versionDescriptor?.value === "string" && versionDescriptor.value.length > 0;
}

/** Reads the package version used by startup logs and MCP metadata. */
function readPackageVersion(): string {
  const rawPackageJson = readFileSync(packageJsonUrl, "utf8");
  const packageJson: unknown = JSON.parse(rawPackageJson);

  if (!isPackageMetadata(packageJson)) {
    throw new Error("email-client-mcp package.json must contain a version string");
  }

  return packageJson.version;
}

/** Package version logged at startup and exposed via MCP metadata. */
export const PACKAGE_VERSION = readPackageVersion();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../../src/version.js";

describe("package version constant", () => {
  it("matches package.json so startup logs show the published version", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      readonly version?: unknown;
    };

    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });
});

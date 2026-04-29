import { describe, expect, it } from "vitest";
import {
  externalIdFor,
  isValidMailboxId,
  parseExternalId,
  sanitizeMailboxId,
} from "../../src/store/conventions.js";

describe("store/conventions", () => {
  /* REQUIREMENT end:comm/email-client-mcp/store/conventions -- mailboxId is a [a-z0-9-]{1,64} slug */
  it("sanitizes account ids into a valid mailbox slug", () => {
    expect(sanitizeMailboxId("Work@Acme.com")).toBe("work-acme-com");
    expect(sanitizeMailboxId("---a__b!!c---")).toBe("a-b-c");
    expect(sanitizeMailboxId("")).toBe("mailbox");
    expect(sanitizeMailboxId("   ")).toBe("mailbox");
    expect(sanitizeMailboxId("SAFE-id-1")).toBe("safe-id-1");
  });

  /* REQUIREMENT end:comm/email-client-mcp/store/conventions -- mailboxId truncates to 64 chars */
  it("truncates oversize input to 64 chars", () => {
    const id = sanitizeMailboxId("a".repeat(200));
    expect(id.length).toBe(64);
    expect(isValidMailboxId(id)).toBe(true);
  });

  /* REQUIREMENT end:comm/email-client-mcp/store/conventions -- externalId encodes (UIDVALIDITY, UID) so a rollover never collides */
  it("builds and parses externalId round-trip", () => {
    expect(externalIdFor(123, 4567)).toBe("123:4567");
    expect(parseExternalId("123:4567")).toEqual({ uidValidity: 123, uid: 4567 });
  });

  /* REQUIREMENT end:comm/email-client-mcp/store/conventions -- malformed externalId returns null (not produced by us) */
  it("rejects malformed externalIds", () => {
    expect(parseExternalId("garbage")).toBeNull();
    expect(parseExternalId("123:abc")).toBeNull();
    expect(parseExternalId("-1:5")).toBeNull();
    expect(parseExternalId("1:2:3")).toBeNull();
  });
});

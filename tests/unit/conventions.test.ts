import { describe, expect, it } from "vitest";
import {
  externalIdFor,
  isValidMailboxId,
  parseExternalId,
  sanitizeMailboxId,
} from "../../src/store/conventions.js";

describe("store/conventions", () => {
  /* REQUIREMENT end:comm/email-client-mcp/store/conventions -- mailboxId is an Exchange-owned [a-z0-9-]{1,64} slug */
  it("maps account ids into exchange-prefixed mailbox slugs", () => {
    expect(sanitizeMailboxId("mail__w1upgraidefr")).toBe("exchange-mail-w1upgraidefr");
    expect(sanitizeMailboxId("google__personal")).toBe("exchange-google-personal");
    expect(sanitizeMailboxId("telegram__personal")).toBe("exchange-telegram-personal");
    expect(sanitizeMailboxId("whatsapp__w1")).toBe("exchange-whatsapp-w1");
    expect(sanitizeMailboxId("Work@Acme.com")).toBe("exchange-work-acme-com");
    expect(sanitizeMailboxId("SAFE-id-1")).toBe("exchange-safe-id-1");
  });

  it("falls back to exchange-default and keeps already-prefixed slugs idempotent", () => {
    expect(sanitizeMailboxId("")).toBe("exchange-default");
    expect(sanitizeMailboxId("   ")).toBe("exchange-default");
    expect(sanitizeMailboxId("exchange-google-personal")).toBe("exchange-google-personal");
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

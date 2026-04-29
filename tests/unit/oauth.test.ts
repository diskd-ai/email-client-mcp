import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthAccount } from "../../src/config/schema.js";
import { refreshOAuthAccessToken } from "../../src/imap/oauth.js";

const account: OAuthAccount = {
  name: "gmail",
  email: "gmail@example.com",
  username: "gmail@example.com",
  oauth2: {
    provider: "google",
    client_id: "client-id",
    client_secret: "client-secret",
    refresh_token: "refresh-token",
  },
  imap: { host: "imap.gmail.com", port: 993, tls: true, verify_ssl: true },
};

describe("imap/oauth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/oauth -- OAuth refresh_token is exchanged for an access_token before XOAUTH2 IMAP login */
  it("exchanges a Google refresh token for an access token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
      const body = String(init?.body);
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=refresh-token");
      return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshOAuthAccessToken(account);

    expect(result).toEqual({ tag: "Ok", value: "access-token" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.anything(),
    );
  });
});

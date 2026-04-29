/**
 * OAuth2 access-token exchange for IMAP XOAUTH2.
 *
 * Gmail and Microsoft IMAP do not accept refresh tokens as IMAP
 * credentials. The refresh token must first be exchanged for a
 * short-lived access token, then passed to ImapFlow as `accessToken`.
 */

import { z } from "zod";
import type { OAuthAccount } from "../config/schema.js";
import { type ImapError, imapError } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

const tokenUrlForProvider = (provider: string): Result<ImapError, string> => {
  switch (provider) {
    case "google":
      return Ok("https://oauth2.googleapis.com/token");
    case "microsoft":
      return Ok("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    default:
      return Err(imapError("oauth", `unsupported oauth2 provider: ${provider}`));
  }
};

export type OAuthTokenFetcher = (account: OAuthAccount) => Promise<Result<ImapError, string>>;

export const refreshOAuthAccessToken: OAuthTokenFetcher = async (
  account,
): Promise<Result<ImapError, string>> => {
  const tokenUrl = tokenUrlForProvider(account.oauth2.provider);
  if (tokenUrl.tag === "Err") {
    return Err(imapError(account.name, tokenUrl.error.message, tokenUrl.error));
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: account.oauth2.client_id,
    client_secret: account.oauth2.client_secret,
    refresh_token: account.oauth2.refresh_token,
  });

  let response: Response;
  try {
    response = await fetch(tokenUrl.value, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (cause) {
    return Err(imapError(account.name, "oauth2 token refresh request failed", cause));
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (cause) {
      return Err(
        imapError(account.name, "oauth2 token refresh failed and body read failed", cause),
      );
    }
    return Err(
      imapError(account.name, `oauth2 token refresh failed (${response.status}): ${text}`),
    );
  }

  try {
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return Err(imapError(account.name, "oauth2 token refresh response missing access_token"));
    }
    return Ok(parsed.data.access_token);
  } catch (cause) {
    return Err(imapError(account.name, "oauth2 token refresh response parse failed", cause));
  }
};

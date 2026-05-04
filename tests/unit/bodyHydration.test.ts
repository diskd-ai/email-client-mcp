import { describe, expect, it } from "vitest";
import type { AppError, ImapError } from "../../src/domain/errors.js";
import { Err, Ok } from "../../src/domain/result.js";
import type { StoredEmailPayload } from "../../src/store/payloadTypes.js";
import {
  type BodyHydrationDeps,
  hydrateStoredMessageBodies,
  hydrateStoredMessageBody,
  markBodyFailedPermanent,
  markBodyFailedRetryable,
  markBodyLoaded,
} from "../../src/sync/bodyHydration.js";

const now = new Date("2026-04-29T10:00:00.000Z");

const basePayload: StoredEmailPayload = {
  accountId: "work",
  mailbox: "INBOX",
  uid: 42,
  uidValidity: 14,
  messageId: "<42@example.com>",
  inReplyTo: null,
  references: [],
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: null, address: "bob@example.com" }],
  cc: [],
  subject: "Hello",
  date: "2026-04-29T09:00:00.000Z",
  flags: ["\\Seen"],
  labels: [],
  hasAttachments: true,
  attachments: [
    {
      attachmentId: "14:42:2",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      partId: "2",
      storageState: "not_loaded",
    },
  ],
  snippet: "",
  bodyText: null,
  bodyHtml: null,
  truncated: false,
  bodyState: "not_loaded",
  bodyFetchedAt: null,
  bodyFetchError: null,
  fetchedAt: "2026-04-29T09:30:00.000Z",
};

const buildDeps = (
  stored: Map<string, StoredEmailPayload>,
  options?: {
    readonly fetchBody?: BodyHydrationDeps["imap"]["fetchBody"];
    readonly upsertError?: string;
    readonly upserted?: StoredEmailPayload[];
  },
): BodyHydrationDeps => ({
  drive: {
    getMessage: async (_mailboxId, _folderId, externalId) => Ok(stored.get(externalId) ?? null),
    upsertMessages: async (_mailboxId, _folderId, payloads, externalIds) => {
      if (options?.upsertError !== undefined) {
        return Err({ kind: "DriveError", message: options.upsertError } as AppError);
      }
      for (let i = 0; i < externalIds.length; i++) {
        const payload = payloads[i];
        const externalId = externalIds[i];
        if (payload !== undefined && externalId !== undefined) {
          stored.set(externalId, payload);
          options?.upserted?.push(payload);
        }
      }
      return Ok({ inserted: 0, updated: payloads.length });
    },
  },
  imap: {
    fetchBody:
      options?.fetchBody ??
      (async () =>
        Ok({
          bodyText: "Loaded text",
          bodyHtml: null,
          truncated: false,
          bytesRead: 11,
        })),
  },
  now: () => now,
});

describe("sync/bodyHydration state transitions", () => {
  /* REQUIREMENT end:comm/email-client-mcp/sync/body-hydration -- loaded body patches only body cache fields */
  it("marks a body as loaded without changing metadata or attachments", () => {
    const loaded = markBodyLoaded(
      basePayload,
      { bodyText: "Hello\n world", bodyHtml: null, truncated: false, bytesRead: 12 },
      now,
    );

    expect(loaded).toMatchObject({
      accountId: basePayload.accountId,
      mailbox: basePayload.mailbox,
      uid: basePayload.uid,
      uidValidity: basePayload.uidValidity,
      subject: basePayload.subject,
      bodyText: "Hello\n world",
      bodyHtml: null,
      snippet: "Hello world",
      bodyState: "loaded",
      bodyFetchedAt: now.toISOString(),
      bodyFetchError: null,
    });
    expect(loaded.attachments).toEqual(basePayload.attachments);
  });

  it("marks retryable and permanent failures without removing existing metadata", () => {
    const retryable = markBodyFailedRetryable(basePayload, "THROTTLED", now);
    expect(retryable.bodyState).toBe("failed_retryable");
    expect(retryable.bodyFetchError).toBe("THROTTLED");
    expect(retryable.attachments).toEqual(basePayload.attachments);

    const permanent = markBodyFailedPermanent(basePayload, "missing body part", now);
    expect(permanent.bodyState).toBe("failed_permanent");
    expect(permanent.bodyFetchError).toBe("missing body part");
    expect(permanent.attachments).toEqual(basePayload.attachments);
  });
});

describe("sync/bodyHydration hydrateStoredMessageBody", () => {
  /* REQUIREMENT end:comm/email-client-mcp/sync/body-hydration -- already loaded messages are served from cache unless refresh is requested */
  it("skips already loaded bodies without IMAP fetch", async () => {
    const stored = new Map<string, StoredEmailPayload>([
      ["14:42", { ...basePayload, bodyState: "loaded", bodyText: "cached", snippet: "cached" }],
    ]);
    let fetchCalls = 0;
    const deps = buildDeps(stored, {
      fetchBody: async () => {
        fetchCalls += 1;
        return Ok({ bodyText: "fresh", bodyHtml: null, truncated: false, bytesRead: 5 });
      },
    });

    const result = await hydrateStoredMessageBody(deps, {
      mailboxId: "exchange-work",
      folderId: "INBOX",
      externalId: "14:42",
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("skipped");
      expect(result.value.payload.bodyText).toBe("cached");
    }
    expect(fetchCalls).toBe(0);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync/body-hydration -- missing body fetches are persisted to messagesStore */
  it("fetches and persists a missing body", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", basePayload]]);
    const upserted: StoredEmailPayload[] = [];
    const deps = buildDeps(stored, { upserted });

    const result = await hydrateStoredMessageBody(deps, {
      mailboxId: "exchange-work",
      folderId: "INBOX",
      externalId: "14:42",
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("loaded");
      expect(result.value.payload.bodyText).toBe("Loaded text");
      expect(result.value.payload.bodyState).toBe("loaded");
    }
    expect(upserted).toHaveLength(1);
    expect(stored.get("14:42")?.bodyText).toBe("Loaded text");
    expect(stored.get("14:42")?.attachments).toEqual(basePayload.attachments);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync/body-hydration -- Gmail throttling becomes retryable body state, not thrown failure */
  it("persists retryable body state for Gmail throttling", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", basePayload]]);
    const throttled: ImapError = {
      kind: "ImapError",
      accountId: "work",
      message: "fetch body failed: Some messages could not be FETCHed (Failure) [THROTTLED]",
    };
    const deps = buildDeps(stored, {
      fetchBody: async () => Err(throttled),
    });

    const result = await hydrateStoredMessageBody(deps, {
      mailboxId: "exchange-work",
      folderId: "INBOX",
      externalId: "14:42",
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("failed_retryable");
      expect(result.value.payload.bodyState).toBe("failed_retryable");
      expect(result.value.payload.bodyFetchError).toContain("THROTTLED");
    }
    expect(stored.get("14:42")?.bodyText).toBeNull();
    expect(stored.get("14:42")?.attachments).toEqual(basePayload.attachments);
  });

  /* REQUIREMENT end:comm/email-client-mcp/sync/body-hydration -- batch body hydration returns partial success instead of failing the whole batch */
  it("hydrates batches with partial success", async () => {
    const loadedPayload: StoredEmailPayload = {
      ...basePayload,
      uid: 41,
      bodyState: "loaded",
      bodyText: "cached",
      snippet: "cached",
    };
    const missingPayload: StoredEmailPayload = { ...basePayload, uid: 42 };
    const throttledPayload: StoredEmailPayload = { ...basePayload, uid: 43 };
    const stored = new Map<string, StoredEmailPayload>([
      ["14:41", loadedPayload],
      ["14:42", missingPayload],
      ["14:43", throttledPayload],
    ]);
    const deps = buildDeps(stored, {
      fetchBody: async (_accountId, _mailbox, uid) => {
        if (uid === 43) {
          return Err({
            kind: "ImapError",
            accountId: "work",
            message: "Some messages could not be FETCHed (Failure) [THROTTLED]",
          });
        }
        return Ok({ bodyText: `loaded-${uid}`, bodyHtml: null, truncated: false, bytesRead: 9 });
      },
    });

    const result = await hydrateStoredMessageBodies(deps, [
      { mailboxId: "exchange-work", folderId: "INBOX", externalId: "14:41" },
      { mailboxId: "exchange-work", folderId: "INBOX", externalId: "14:42" },
      { mailboxId: "exchange-work", folderId: "INBOX", externalId: "14:43" },
    ]);

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.skipped.map((item) => item.ref.externalId)).toEqual(["14:41"]);
      expect(result.value.loaded.map((item) => item.ref.externalId)).toEqual(["14:42"]);
      expect(result.value.failedRetryable.map((item) => item.ref.externalId)).toEqual(["14:43"]);
      expect(result.value.failedPermanent).toEqual([]);
    }
    expect(stored.get("14:42")?.bodyText).toBe("loaded-42");
    expect(stored.get("14:43")?.bodyState).toBe("failed_retryable");
  });

  it("persists permanent body state when IMAP returns no body for an indexed message", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", basePayload]]);
    const deps = buildDeps(stored, {
      fetchBody: async () => Ok(null),
    });

    const result = await hydrateStoredMessageBody(deps, {
      mailboxId: "exchange-work",
      folderId: "INBOX",
      externalId: "14:42",
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("failed_permanent");
      expect(result.value.payload.bodyState).toBe("failed_permanent");
      expect(result.value.payload.bodyFetchError).toContain("message body not found");
    }
  });
});

import { describe, expect, it } from "vitest";
import type { AppError, ImapError } from "../../src/domain/errors.js";
import { Err, Ok } from "../../src/domain/result.js";
import type { StoredEmailPayload } from "../../src/store/payloadTypes.js";
import type { BodyHydrationDeps } from "../../src/sync/bodyHydration.js";
import { registerTools } from "../../src/tools/registry.js";
import {
  systemHydrateEmailBodies,
  systemHydrateEmailBodiesInput,
} from "../../src/tools/systemHydrateEmailBodies.js";

const now = new Date("2026-04-29T10:00:00.000Z");

const payload = (uid: number, overrides?: Partial<StoredEmailPayload>): StoredEmailPayload => ({
  accountId: "work",
  mailbox: "INBOX",
  uid,
  uidValidity: 14,
  messageId: `<${uid}@example.com>`,
  inReplyTo: null,
  references: [],
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: null, address: "bob@example.com" }],
  cc: [],
  subject: `Subject ${uid}`,
  date: "2026-04-29T09:00:00.000Z",
  flags: [],
  labels: [],
  hasAttachments: true,
  attachments: [
    {
      attachmentId: `14:${uid}:2`,
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
  ...overrides,
});

const buildDeps = (
  stored: Map<string, StoredEmailPayload>,
  options?: {
    readonly fetchBodyErrors?: ReadonlyMap<number, ImapError>;
    readonly fetchCalls?: number[];
  },
): BodyHydrationDeps => ({
  drive: {
    getMessage: async (_mailboxId, _folderId, externalId) => Ok(stored.get(externalId) ?? null),
    upsertMessages: async (_mailboxId, _folderId, payloads, externalIds) => {
      for (let i = 0; i < externalIds.length; i++) {
        const externalId = externalIds[i];
        const next = payloads[i];
        if (externalId !== undefined && next !== undefined) stored.set(externalId, next);
      }
      return Ok({ inserted: 0, updated: payloads.length });
    },
  },
  imap: {
    fetchBody: async (_accountId, _mailbox, uid) => {
      options?.fetchCalls?.push(uid);
      const error = options?.fetchBodyErrors?.get(uid);
      if (error !== undefined) return Err(error);
      return Ok({ bodyText: `loaded-${uid}`, bodyHtml: null, truncated: false, bytesRead: 8 });
    },
  },
  now: () => now,
});

const ref = (uid: number) => ({
  mailboxId: "exchange-work",
  folderId: "INBOX",
  externalId: `14:${uid}`,
});

describe("tools/system_hydrate_email_bodies", () => {
  /* REQUIREMENT end:comm/email-client-mcp/tools/system-hydrate-email-bodies -- system tool caps request size */
  it("rejects more than 50 message refs", () => {
    const result = systemHydrateEmailBodiesInput.safeParse({
      messages: Array.from({ length: 51 }, (_, i) => ref(i + 1)),
    });

    expect(result.success).toBe(false);
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools/system-hydrate-email-bodies -- hydrates message bodies by messagesStore refs */
  it("hydrates unloaded messages and returns partial-success buckets", async () => {
    const stored = new Map<string, StoredEmailPayload>([
      ["14:1", payload(1, { bodyState: "loaded", bodyText: "cached", snippet: "cached" })],
      ["14:2", payload(2)],
      ["14:3", payload(3)],
    ]);
    const fetchCalls: number[] = [];
    const throttled: ImapError = {
      kind: "ImapError",
      accountId: "work",
      message: "Some messages could not be FETCHed (Failure) [THROTTLED]",
    };

    const result = await systemHydrateEmailBodies(
      buildDeps(stored, { fetchCalls, fetchBodyErrors: new Map([[3, throttled]]) }),
      { messages: [ref(1), ref(2), ref(3)] },
    );

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.skipped.map((item) => item.ref.externalId)).toEqual(["14:1"]);
      expect(result.value.loaded.map((item) => item.ref.externalId)).toEqual(["14:2"]);
      expect(result.value.failedRetryable.map((item) => item.ref.externalId)).toEqual(["14:3"]);
      expect(result.value.failedPermanent).toEqual([]);
      expect(result.value.loaded[0]?.payload.bodyText).toBe("loaded-2");
    }
    expect(fetchCalls).toEqual([2, 3]);
    expect(stored.get("14:2")?.bodyState).toBe("loaded");
    expect(stored.get("14:3")?.bodyState).toBe("failed_retryable");
    expect(stored.get("14:2")?.attachments).toEqual(payload(2).attachments);
  });

  it("passes refresh and maxMessages through to the hydration core", async () => {
    const stored = new Map<string, StoredEmailPayload>([
      ["14:1", payload(1, { bodyState: "loaded", bodyText: "cached", snippet: "cached" })],
      ["14:2", payload(2)],
      ["14:3", payload(3)],
    ]);
    const fetchCalls: number[] = [];

    const result = await systemHydrateEmailBodies(buildDeps(stored, { fetchCalls }), {
      messages: [ref(1), ref(2), ref(3)],
      refresh: true,
      maxMessages: 2,
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.loaded.map((item) => item.ref.externalId)).toEqual(["14:1", "14:2"]);
      expect(result.value.skipped).toEqual([]);
    }
    expect(fetchCalls).toEqual([1, 2]);
    expect(stored.get("14:1")?.bodyText).toBe("loaded-1");
    expect(stored.get("14:3")?.bodyState).toBe("not_loaded");
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools/registry -- system hydration tool is registered in the MCP runtime */
  it("registers the system hydration tool", async () => {
    const registered: Array<{ name: string; callback: (args: unknown) => Promise<unknown> }> = [];
    const server = {
      registerTool: (
        name: string,
        _config: unknown,
        callback: (args: unknown) => Promise<unknown>,
      ) => {
        registered.push({ name, callback });
      },
    };
    const stored = new Map<string, StoredEmailPayload>([["14:2", payload(2)]]);

    registerTools(server as never, {
      accounts: [],
      imapPool: {} as never,
      watcher: {} as never,
      bodyHydration: buildDeps(stored),
    });

    const tool = registered.find((item) => item.name === "system_hydrate_email_bodies");
    expect(tool).toBeDefined();
    const response = (await tool?.callback({ messages: [ref(2)] })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(response.content[0]?.text ?? "{}").loaded[0].ref.externalId).toBe("14:2");
  });

  it("returns an app error when a message ref is not found", async () => {
    const result = await systemHydrateEmailBodies(buildDeps(new Map()), {
      messages: [ref(404)],
    });

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect((result.error as AppError).kind).toBe("NotFound");
    }
  });
});

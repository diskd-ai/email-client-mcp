import { describe, expect, it } from "vitest";
import type { AppError } from "../../src/domain/errors.js";
import { Ok } from "../../src/domain/result.js";
import type { StoredEmailPayload } from "../../src/store/payloadTypes.js";
import type { AttachmentHydrationDeps } from "../../src/sync/attachmentHydration.js";
import { registerTools } from "../../src/tools/registry.js";
import {
  systemHydrateEmailAttachment,
  systemHydrateEmailAttachmentInput,
} from "../../src/tools/systemHydrateEmailAttachment.js";

const payload: StoredEmailPayload = {
  accountId: "work",
  mailbox: "INBOX",
  uid: 42,
  uidValidity: 14,
  messageId: "<42@example.com>",
  inReplyTo: null,
  references: [],
  from: null,
  to: [],
  cc: [],
  subject: "Hello",
  date: "2026-04-29T09:00:00.000Z",
  flags: [],
  labels: [],
  hasAttachments: true,
  attachments: [
    {
      attachmentId: "14:42:2",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 5,
      partId: "2",
      storageState: "not_loaded",
    },
  ],
  snippet: "body",
  bodyText: "body",
  bodyHtml: null,
  truncated: false,
  bodyState: "loaded",
  bodyFetchedAt: "2026-04-29T09:30:00.000Z",
  bodyFetchError: null,
  fetchedAt: "2026-04-29T09:30:00.000Z",
};

const buildDeps = (stored: Map<string, StoredEmailPayload>): AttachmentHydrationDeps => ({
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
    uploadAttachment: async (_mailboxId, _folderId, _externalId, attachment, content) => {
      for await (const _chunk of content) {
        // consume
      }
      return Ok({
        attachmentId: attachment.attachmentId,
        storedSizeBytes: attachment.sizeBytes,
        storedAt: "2026-04-29T10:00:00.000Z",
      });
    },
  },
  imap: {
    downloadPart: async () => ({
      content: (async function* (): AsyncIterable<Uint8Array> {
        yield Buffer.from("bytes");
      })(),
      sizeBytes: 5,
      contentType: "application/pdf",
      dispose: () => undefined,
    }),
  },
});

const input = {
  mailboxId: "exchange-work",
  folderId: "INBOX",
  externalId: "14:42",
  attachmentId: "14:42:2",
};

describe("tools/system_hydrate_email_attachment", () => {
  /* REQUIREMENT end:comm/email-client-mcp/tools/system-hydrate-email-attachment -- validates system attachment refs */
  it("validates required message and attachment refs", () => {
    expect(systemHydrateEmailAttachmentInput.safeParse(input).success).toBe(true);
    expect(
      systemHydrateEmailAttachmentInput.safeParse({ ...input, attachmentId: "" }).success,
    ).toBe(false);
  });

  it("hydrates one attachment through the system tool", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", payload]]);

    const result = await systemHydrateEmailAttachment(buildDeps(stored), input);

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("loaded");
      expect(result.value.attachment?.storageState).toBe("loaded");
      expect(result.value.attachment?.storedAt).toBe("2026-04-29T10:00:00.000Z");
    }
    expect(stored.get("14:42")?.bodyState).toBe("loaded");
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools/registry -- system attachment hydration tool is registered in the MCP runtime */
  it("registers the system attachment hydration tool", async () => {
    const registered: Array<{ name: string; callback: (args: unknown) => Promise<unknown> }> = [];
    const server = {
      registerTool: (
        name: string,
        _config: unknown,
        callback: (args: unknown) => Promise<unknown>,
      ) => registered.push({ name, callback }),
    };
    const stored = new Map<string, StoredEmailPayload>([["14:42", payload]]);

    registerTools(server as never, {
      accounts: [],
      imapPool: {} as never,
      watcher: {} as never,
      bodyHydration: {} as never,
      attachmentHydration: buildDeps(stored),
    });

    const tool = registered.find((item) => item.name === "system_hydrate_email_attachment");
    expect(tool).toBeDefined();
    const response = (await tool?.callback(input)) as { content: Array<{ text: string }> };
    expect(JSON.parse(response.content[0]?.text ?? "{}").status).toBe("loaded");
  });

  it("returns an app error when the message ref is not found", async () => {
    const result = await systemHydrateEmailAttachment(buildDeps(new Map()), input);

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect((result.error as AppError).kind).toBe("NotFound");
  });
});

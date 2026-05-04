import { describe, expect, it } from "vitest";
import type { AppError } from "../../src/domain/errors.js";
import { Err, Ok } from "../../src/domain/result.js";
import type { UploadAttachmentResult } from "../../src/store/attachments.js";
import type { StoredAttachment, StoredEmailPayload } from "../../src/store/payloadTypes.js";
import {
  type AttachmentHydrationDeps,
  hydrateStoredMessageAttachment,
} from "../../src/sync/attachmentHydration.js";

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
  flags: [],
  labels: [],
  hasAttachments: true,
  attachments: [
    {
      attachmentId: "14:42:2",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 12,
      partId: "2",
      storageState: "not_loaded",
    },
    {
      attachmentId: "14:42:3",
      filename: "other.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      partId: "3",
      storageState: "not_loaded",
    },
  ],
  snippet: "cached body",
  bodyText: "cached body",
  bodyHtml: null,
  truncated: false,
  bodyState: "loaded",
  bodyFetchedAt: "2026-04-29T09:30:00.000Z",
  bodyFetchError: null,
  fetchedAt: "2026-04-29T09:30:00.000Z",
};

const buildDeps = (
  stored: Map<string, StoredEmailPayload>,
  options?: {
    readonly downloadThrows?: unknown;
    readonly uploadError?: AppError;
    readonly downloadCalls?: string[];
    readonly uploadCalls?: string[];
    readonly disposeCalls?: string[];
  },
): AttachmentHydrationDeps => ({
  drive: {
    getMessage: async (_mailboxId, _folderId, externalId) => Ok(stored.get(externalId) ?? null),
    upsertMessages: async (_mailboxId, _folderId, payloads, externalIds) => {
      for (let i = 0; i < externalIds.length; i++) {
        const payload = payloads[i];
        const externalId = externalIds[i];
        if (payload !== undefined && externalId !== undefined) stored.set(externalId, payload);
      }
      return Ok({ inserted: 0, updated: payloads.length });
    },
    uploadAttachment: async (_mailboxId, _folderId, _externalId, attachment, content) => {
      options?.uploadCalls?.push(`${attachment.attachmentId}:${attachment.partId}`);
      if (options?.uploadError !== undefined) return Err(options.uploadError);
      const chunks: string[] = [];
      for await (const chunk of content) chunks.push(Buffer.from(chunk).toString("utf8"));
      expect(chunks).toEqual(["hello", "-attachment"]);
      return Ok({
        attachmentId: attachment.attachmentId,
        storedSizeBytes: attachment.sizeBytes,
        storedAt: "2026-04-29T10:00:00.000Z",
      } satisfies UploadAttachmentResult);
    },
  },
  imap: {
    downloadPart: async (accountId, mailbox, uid, partId) => {
      options?.downloadCalls?.push(`${accountId}:${mailbox}:${uid}:${partId}`);
      if (options?.downloadThrows !== undefined) throw options.downloadThrows;
      return {
        content: (async function* (): AsyncIterable<Uint8Array> {
          yield Buffer.from("hello");
          yield Buffer.from("-attachment");
        })(),
        sizeBytes: 12,
        contentType: "application/pdf",
        dispose: () => options?.disposeCalls?.push(`${uid}:${partId}`),
      };
    },
  },
});

const ref = {
  mailboxId: "exchange-work",
  folderId: "INBOX",
  externalId: "14:42",
  attachmentId: "14:42:2",
};

describe("sync/attachmentHydration", () => {
  /* REQUIREMENT end:comm/email-client-mcp/sync/attachment-hydration -- hydrates exactly one attachment without changing body state */
  it("hydrates one attachment and patches only that attachment", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", basePayload]]);
    const downloadCalls: string[] = [];
    const uploadCalls: string[] = [];
    const disposeCalls: string[] = [];

    const result = await hydrateStoredMessageAttachment(
      buildDeps(stored, { downloadCalls, uploadCalls, disposeCalls }),
      ref,
    );

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("loaded");
      expect(result.value.attachment?.storageState).toBe("loaded");
      expect(result.value.attachment?.storedSizeBytes).toBe(12);
    }
    expect(downloadCalls).toEqual(["work:INBOX:42:2"]);
    expect(uploadCalls).toEqual(["14:42:2:2"]);
    expect(disposeCalls).toEqual(["42:2"]);
    const patched = stored.get("14:42");
    expect(patched?.bodyState).toBe("loaded");
    expect(patched?.bodyText).toBe("cached body");
    expect(patched?.attachments[0]).toMatchObject({
      attachmentId: "14:42:2",
      storageState: "loaded",
      storedAt: "2026-04-29T10:00:00.000Z",
      storedSizeBytes: 12,
    });
    expect(patched?.attachments[1]).toEqual(basePayload.attachments[1]);
  });

  it("skips already loaded attachments unless refresh is requested", async () => {
    const [originalLoadedAttachment, otherAttachment] = basePayload.attachments;
    if (originalLoadedAttachment === undefined || otherAttachment === undefined) {
      throw new Error("test fixture must contain two attachments");
    }
    const loadedAttachment: StoredAttachment = {
      ...originalLoadedAttachment,
      storageState: "loaded",
      storedAt: "2026-04-29T09:00:00.000Z",
      storedSizeBytes: 12,
    };
    const stored = new Map<string, StoredEmailPayload>([
      ["14:42", { ...basePayload, attachments: [loadedAttachment, otherAttachment] }],
    ]);
    const downloadCalls: string[] = [];

    const result = await hydrateStoredMessageAttachment(buildDeps(stored, { downloadCalls }), ref);

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.status).toBe("skipped");
    expect(downloadCalls).toEqual([]);

    await hydrateStoredMessageAttachment(buildDeps(stored, { downloadCalls }), ref, {
      refresh: true,
    });
    expect(downloadCalls).toEqual(["work:INBOX:42:2"]);
  });

  it("marks throttled attachment downloads as retryable without changing body state", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", basePayload]]);

    const result = await hydrateStoredMessageAttachment(
      buildDeps(stored, {
        downloadThrows: new Error("Some messages could not be FETCHed (Failure) [THROTTLED]"),
      }),
      ref,
    );

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("failed_retryable");
      expect(result.value.error).toContain("THROTTLED");
    }
    const patched = stored.get("14:42");
    expect(patched?.bodyState).toBe("loaded");
    expect(patched?.attachments[0]).toMatchObject({
      storageState: "failed_retryable",
      lastLoadError: expect.stringContaining("THROTTLED"),
    });
  });

  it("returns permanent failure for a missing attachment id", async () => {
    const stored = new Map<string, StoredEmailPayload>([["14:42", basePayload]]);

    const result = await hydrateStoredMessageAttachment(buildDeps(stored), {
      ...ref,
      attachmentId: "missing",
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.status).toBe("failed_permanent");
      expect(result.value.attachment).toBeNull();
    }
    expect(stored.get("14:42")?.attachments).toEqual(basePayload.attachments);
  });
});

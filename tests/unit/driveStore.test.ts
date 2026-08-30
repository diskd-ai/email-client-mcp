import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDriveStore } from "../../src/store/driveStore.js";

const chunks = async function* (): AsyncIterable<Uint8Array> {
  yield Buffer.from("hello");
  yield Buffer.from("-");
  yield Buffer.from("world");
};

const buildStore = (options?: {
  readonly commitConflict?: boolean;
  readonly commitConflictOnce?: boolean;
  readonly uploadStartConflictOnce?: boolean;
  readonly listedSize?: number;
  readonly listedContentType?: string;
  readonly alreadyUploaded?: boolean;
  readonly sentinelAlreadyUploaded?: boolean;
}) => {
  let uploadStartCalls = 0;
  let uploadCommitCalls = 0;
  const attachments = {
    uploadStart: vi.fn(async () => {
      uploadStartCalls += 1;
      if (options?.uploadStartConflictOnce === true && uploadStartCalls === 1) {
        throw new Error("JSON-RPC error: CONFLICT");
      }
      return options?.alreadyUploaded
        ? {
            alreadyUploaded: true,
            intentId: null,
            uploadUrl: null,
            attachmentId: "14:94:2",
            sizeBytes: options?.listedSize ?? 11,
            createdAt: "2026-04-29T10:00:00.000Z",
          }
        : options?.sentinelAlreadyUploaded
          ? {
              intentId: "already-uploaded",
              uploadUrl: "already-uploaded://attachment",
            }
          : {
              alreadyUploaded: false,
              intentId: "intent-1",
              uploadUrl: "/api/v1/drive/upload",
            };
    }),
    uploadCommit: vi.fn(async () => {
      uploadCommitCalls += 1;
      if (
        options?.commitConflict ||
        (options?.commitConflictOnce === true && uploadCommitCalls === 1)
      ) {
        throw new Error("JSON-RPC error: CONFLICT");
      }
      return {
        attachmentId: "14:94:2",
        driveInode: "inode-new",
        sizeBytes: 11,
      };
    }),
    list: vi.fn(async () => [
      {
        attachmentId: "14:94:2",
        filename: "report.pdf",
        contentType: options?.listedContentType ?? "application/pdf",
        sizeBytes: options?.listedSize ?? 11,
        driveInode: "inode-existing",
        createdAt: "2026-04-29T10:00:00.000Z",
      },
    ]),
    delete: vi.fn(async () => ({ deleted: true })),
  };
  const store = {
    mailbox: vi.fn(() => ({
      folder: vi.fn(() => ({
        message: vi.fn(() => ({ attachments })),
      })),
    })),
  };
  return { store, attachments };
};

const originalFetch = globalThis.fetch;

const stubFetch = (fn: typeof fetch): void => {
  globalThis.fetch = fn;
};

describe("store/buildDriveStore ensureMailbox", () => {
  beforeEach(() => {
    process.env.APIS_BASE_URL = "https://app.example.test";
    process.env.APIS_API_KEY = "api-key";
    process.env.APIS_WORKSPACE_ID = "workspace-1";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates new mailboxes without a storage-version parameter and still runs init", async () => {
    /* REQ-3066-010: New mailboxes must persist explicit email metadata before schema initialization. */
    const createMailbox = vi.fn(async () => ({
      mailboxId: "mail-w1",
      dbInode: "",
      drivePath: "",
    }));
    const init = vi.fn(async () => ({
      mailboxId: "mail-w1",
      schemaVersion: 2,
    }));
    const store = {
      listMailboxes: vi.fn(async () => []),
      createMailbox,
      mailbox: vi.fn(() => ({ init })),
    };
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    stubFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { mailbox_id: "mail-w1", db_inode: "", drive_path: "" },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.ensureMailbox("mail-w1", "Work", {
      email: "w1@example.com",
    });

    expect(result.tag).toBe("Ok");
    expect(createMailbox).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://app.example.test/v1/os/drive/api/v1");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Api-Key": "api-key",
      "X-Workspace-Id": "workspace-1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "messages_store/create_mailbox",
      params: {
        mailbox_id: "mail-w1",
        display_name: "Work",
        metadata: { email: "w1@example.com" },
      },
    });
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("refreshes metadata for an existing mailbox without changing its identity", async () => {
    /* REQ-3066-005: Existing mailboxes must receive current email metadata during sync bootstrap. */
    const createMailbox = vi.fn(async () => ({
      mailboxId: "mail-w1",
      dbInode: "",
      drivePath: "",
    }));
    const init = vi.fn(async () => ({
      mailboxId: "mail-w1",
      schemaVersion: 1,
    }));
    const store = {
      listMailboxes: vi.fn(async () => [
        {
          mailboxId: "mail-w1",
          displayName: "Old label",
          metadata: {},
          dbInode: "inode-1",
          recordCount: 0,
          sizeBytes: 0,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
      createMailbox,
      mailbox: vi.fn(() => ({ init })),
    };
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    stubFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { mailbox_id: "mail-w1", db_inode: "", drive_path: "" },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.ensureMailbox("mail-w1", "Work", {
      email: "w1@example.com",
    });

    expect(result.tag).toBe("Ok");
    expect(createMailbox).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      method: "messages_store/create_mailbox",
      params: {
        mailbox_id: "mail-w1",
        display_name: "Work",
        metadata: { email: "w1@example.com" },
        recreate: true,
      },
    });
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("treats mailbox already exists from createMailbox as idempotent success", async () => {
    /* REQ-3066-011: Concurrent mailbox creation must remain idempotent when metadata is supplied. */
    const init = vi.fn(async () => ({
      mailboxId: "mail-w1",
      schemaVersion: 2,
    }));
    const store = {
      listMailboxes: vi.fn(async () => []),
      createMailbox: vi.fn(),
      mailbox: vi.fn(() => ({ init })),
    };
    stubFetch(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: {
                code: -32000,
                message: "mailbox already exists: mail-w1",
              },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.ensureMailbox("mail-w1", "Work", {
      email: "w1@example.com",
    });

    expect(result.tag).toBe("Ok");
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe("store/buildDriveStore patchMessages", () => {
  beforeEach(() => {
    process.env.APIS_BASE_URL = "https://app.example.test";
    process.env.APIS_API_KEY = "api-key";
    process.env.APIS_WORKSPACE_ID = "workspace-1";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls messages_store/patch-batch through raw Drive JSON-RPC", async () => {
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
    stubFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { patched: 2, missing_external_ids: ["14:99"] },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    const drive = buildDriveStore({} as never);

    const result = await drive.patchMessages("mail-w1", "INBOX", [
      {
        externalId: "14:94",
        payloadPatch: {
          flags: ["\\Seen"],
          labels: ["Important"],
          fetchedAt: "now",
        },
      },
    ]);

    expect(result).toEqual({
      tag: "Ok",
      value: { patched: 2, missingExternalIds: ["14:99"] },
    });
    expect(calls[0]?.url).toBe("https://app.example.test/v1/os/drive/api/v1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "messages_store/patch-batch",
      params: {
        mailbox_id: "mail-w1",
        folder_id: "INBOX",
        auto_commit: false,
        items: [
          {
            external_id: "14:94",
            payload_patch: {
              flags: ["\\Seen"],
              labels: ["Important"],
              fetchedAt: "now",
            },
          },
        ],
      },
    });
  });
});

describe("store/buildDriveStore message reconciliation", () => {
  /* REQ-SYNC-PRUNE-002: Reconciliation reads every Drive message page before comparing provider membership. */
  it("lists message external IDs across all Drive pages", async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { externalId: "1:3", payload: {}, createdAt: "now", updatedAt: "now" },
          { externalId: "1:2", payload: {}, createdAt: "now", updatedAt: "now" },
        ],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        items: [{ externalId: "1:1", payload: {}, createdAt: "now", updatedAt: "now" }],
        nextCursor: null,
      });
    const folder = { listMessages };
    const store = {
      mailbox: vi.fn(() => ({ folder: vi.fn(() => folder) })),
    };

    const result = await buildDriveStore(store as never).listMessageExternalIds(
      "exchange-work",
      "INBOX",
    );

    expect(result).toEqual({ tag: "Ok", value: ["1:3", "1:2", "1:1"] });
    expect(listMessages).toHaveBeenNthCalledWith(1, { limit: 1000 });
    expect(listMessages).toHaveBeenNthCalledWith(2, { limit: 1000, cursor: "cursor-1" });
  });

  /* REQ-SYNC-PRUNE-003: Reconciliation deletes only explicitly identified stale external IDs. */
  it("deletes the supplied stale external IDs through the scoped folder", async () => {
    const deleteBatch = vi.fn(async () => ({ deleted: 2 }));
    const folder = { deleteBatch };
    const store = {
      mailbox: vi.fn(() => ({ folder: vi.fn(() => folder) })),
    };

    const result = await buildDriveStore(store as never).deleteMessages("exchange-work", "INBOX", [
      "1:2",
      "1:4",
    ]);

    expect(result).toEqual({ tag: "Ok", value: { deleted: 2 } });
    expect(deleteBatch).toHaveBeenCalledWith({ externalIds: ["1:2", "1:4"] });
  });
});

describe("store/buildDriveStore attachment upload", () => {
  beforeEach(() => {
    process.env.APIS_BASE_URL = "https://app.example.test";
    process.env.APIS_API_KEY = "api-key";
    process.env.APIS_WORKSPACE_ID = "workspace-1";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("streams PUT bytes with upload intent headers and commits the attachment", async () => {
    const { store, attachments } = buildStore();
    const consumed: string[] = [];
    stubFetch(
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        for await (const chunk of init?.body as AsyncIterable<Uint8Array>) {
          consumed.push(Buffer.from(chunk).toString("utf8"));
        }
        return new Response(JSON.stringify({ etag: "etag-1" }), {
          status: 200,
        });
      }) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value).toMatchObject({
        attachmentId: "14:94:2",
        storedSizeBytes: 11,
      });
      expect("driveInode" in result.value).toBe(false);
    }
    expect(consumed).toEqual(["hello", "-", "world"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://app.example.test/v1/os/drive/api/v1/drive/upload",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "X-Api-Key": "api-key",
          "X-Workspace-Id": "workspace-1",
          "X-Upload-Intent-Id": "intent-1",
          "Content-Length": "11",
          "Content-Type": "application/pdf",
        }),
        duplex: "half",
      }),
    );
    expect(attachments.uploadCommit).toHaveBeenCalledWith({
      attachmentId: "14:94:2",
      intentId: "intent-1",
      etag: "etag-1",
      autoCommit: false,
    });
  });

  it("treats idempotent upload-start as an already stored attachment", async () => {
    const { store, attachments } = buildStore({ alreadyUploaded: true });
    stubFetch(vi.fn() as typeof fetch);

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(fetch).not.toHaveBeenCalled();
    expect(attachments.uploadCommit).not.toHaveBeenCalled();
    if (result.tag === "Ok") {
      expect(result.value).toEqual({
        attachmentId: "14:94:2",
        storedSizeBytes: 11,
        storedAt: "2026-04-29T10:00:00.000Z",
      });
    }
  });

  it("treats wire-compatible idempotent upload-start sentinel as an already stored attachment", async () => {
    const { store, attachments } = buildStore({
      sentinelAlreadyUploaded: true,
    });
    stubFetch(vi.fn() as typeof fetch);

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(fetch).not.toHaveBeenCalled();
    expect(attachments.uploadCommit).not.toHaveBeenCalled();
    expect(attachments.list).toHaveBeenCalledTimes(1);
    if (result.tag === "Ok") {
      expect(result.value).toEqual({
        attachmentId: "14:94:2",
        storedSizeBytes: 11,
        storedAt: "2026-04-29T10:00:00.000Z",
      });
    }
  });

  it("treats duplicate attachment commit as idempotent only when metadata matches", async () => {
    const { store, attachments } = buildStore({ commitConflict: true });
    stubFetch(
      vi.fn(
        async () => new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 }),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(attachments.list).toHaveBeenCalledTimes(1);
    if (result.tag === "Ok") {
      expect("driveInode" in result.value).toBe(false);
      expect(result.value.storedAt).toBe("2026-04-29T10:00:00.000Z");
    }
  });

  it("overwrites an existing attachment when upload-start reports conflicting metadata", async () => {
    const { store, attachments } = buildStore({
      uploadStartConflictOnce: true,
      listedSize: 12,
    });
    stubFetch(
      vi.fn(
        async () => new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 }),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(attachments.delete).toHaveBeenCalledWith({
      attachmentId: "14:94:2",
      autoCommit: false,
    });
    expect(attachments.uploadStart).toHaveBeenCalledTimes(2);
    expect(attachments.uploadCommit).toHaveBeenCalledTimes(1);
  });

  it("overwrites an existing attachment when upload-commit reports conflicting metadata", async () => {
    const { store, attachments } = buildStore({
      commitConflictOnce: true,
      listedSize: 12,
    });
    stubFetch(
      vi.fn(
        async () => new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 }),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(attachments.delete).toHaveBeenCalledWith({
      attachmentId: "14:94:2",
      autoCommit: false,
    });
    expect(attachments.uploadCommit).toHaveBeenCalledTimes(2);
  });

  it("keeps generic MIME retries idempotent without overwriting", async () => {
    const { store, attachments } = buildStore({
      commitConflict: true,
      listedContentType: "application/octet-stream",
    });
    stubFetch(
      vi.fn(
        async () => new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 }),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(attachments.delete).not.toHaveBeenCalled();
    expect(attachments.uploadCommit).toHaveBeenCalledTimes(1);
  });
});

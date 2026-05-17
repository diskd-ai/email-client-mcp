import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../../src/domain/errors.js";
import { Ok, type Result } from "../../src/domain/result.js";
import type { ImapPool } from "../../src/imap/pool.js";
import { registerTools } from "../../src/tools/registry.js";
import type { MessageMirrorPatchStore } from "../../src/tools/setEmailAttributes.js";
import { setEmailAttributes, setEmailAttributesInput } from "../../src/tools/setEmailAttributes.js";

type FakeClient = {
  readonly getMailboxLock: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
  readonly messageFlagsAdd: ReturnType<typeof vi.fn>;
  readonly messageFlagsRemove: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
};

const buildClient = (): { readonly client: FakeClient; readonly releases: { count: number } } => {
  const releases = { count: 0 };
  const client: FakeClient = {
    getMailboxLock: vi.fn(async () => ({
      release: () => {
        releases.count += 1;
      },
    })),
    status: vi.fn(async () => ({ uidValidity: 14 })),
    messageFlagsAdd: vi.fn(async () => true),
    messageFlagsRemove: vi.fn(async () => true),
    fetch: vi.fn(async function* () {
      yield {
        uid: 94,
        flags: new Set(["\\Seen", "\\Flagged"]),
        labels: new Set(["Important"]),
        envelope: { subject: "Updated" },
        bodyStructure: { type: "text/plain" },
        internalDate: new Date("2026-05-17T10:00:00.000Z"),
      };
    }),
  };
  return { client, releases };
};

const buildPool = (client: FakeClient): ImapPool => ({
  accountIds: ["work"],
  forAccount: vi.fn(async () => Ok(client as never)),
  closeAll: vi.fn(async () => undefined),
});

const buildMirror = (
  result: Result<AppError, { patched: number; missingExternalIds: readonly string[] }> = Ok({
    patched: 1,
    missingExternalIds: [],
  }),
): MessageMirrorPatchStore => ({
  patchMessages: vi.fn(async () => result),
});

describe("setEmailAttributes", () => {
  /* REQUIREMENT end:comm/email-client-mcp/tools -- set_email_attributes marks messages read through IMAP and patches the Drive mirror */
  it("marks messages read and patches the mirror with authoritative IMAP flags", async () => {
    const { client, releases } = buildClient();
    const mirror = buildMirror();

    const result = await setEmailAttributes(buildPool(client), mirror, {
      account: "work",
      mailbox: "INBOX",
      uids: [94],
      attributes: { read: true },
    });

    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.status).toHaveBeenCalledWith("INBOX", { uidValidity: true });
    expect(client.messageFlagsAdd).toHaveBeenCalledWith([94], ["\\Seen"], { uid: true });
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    expect(client.fetch).toHaveBeenCalledWith(
      "94",
      {
        uid: true,
        flags: true,
        labels: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
      },
      { uid: true },
    );
    expect(mirror.patchMessages).toHaveBeenCalledWith("exchange-work", "INBOX", [
      {
        externalId: "14:94",
        payloadPatch: {
          flags: ["\\Seen", "\\Flagged"],
          labels: ["Important"],
          fetchedAt: expect.any(String),
        },
      },
    ]);
    expect(result.value.mirrorPatch).toEqual({
      tag: "patched",
      patched: 1,
      missingExternalIds: [],
    });
    expect(releases.count).toBe(1);
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools -- set_email_attributes can apply unread and unflagged state in one mailbox lock */
  it("removes Seen and Flagged flags in one mailbox lock", async () => {
    const { client, releases } = buildClient();

    const result = await setEmailAttributes(buildPool(client), buildMirror(), {
      account: "work",
      mailbox: "INBOX",
      uids: [94],
      attributes: { read: false, flagged: false },
    });

    expect(result.tag).toBe("Ok");
    expect(client.messageFlagsRemove).toHaveBeenCalledWith([94], ["\\Seen"], { uid: true });
    expect(client.messageFlagsRemove).toHaveBeenCalledWith([94], ["\\Flagged"], { uid: true });
    expect(client.getMailboxLock).toHaveBeenCalledTimes(1);
    expect(releases.count).toBe(1);
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools -- set_email_attributes surfaces mirror patch failures after IMAP success */
  it("returns a visible mirror failure when Drive patching fails after IMAP success", async () => {
    const { client } = buildClient();
    const mirror = buildMirror({
      tag: "Err",
      error: { kind: "DriveError", message: "patch unavailable" },
    });

    const result = await setEmailAttributes(buildPool(client), mirror, {
      account: "work",
      mailbox: "INBOX",
      uids: [94],
      attributes: { flagged: true },
    });

    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(client.messageFlagsAdd).toHaveBeenCalledWith([94], ["\\Flagged"], { uid: true });
    expect(result.value.mirrorPatch).toEqual({
      tag: "failed",
      error: "drive: patch unavailable",
    });
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools -- set_email_attributes rejects virtual folders before IMAP mutation */
  it("rejects virtual folders before mutating IMAP", async () => {
    const { client } = buildClient();

    const result = await setEmailAttributes(buildPool(client), buildMirror(), {
      account: "work",
      mailbox: "[Gmail]/All Mail",
      uids: [94],
      attributes: { read: true },
    });

    expect(result).toEqual({
      tag: "Err",
      error: { kind: "VirtualFolderRefused", mailbox: "[Gmail]/All Mail" },
    });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools -- set_email_attributes requires at least one attribute */
  it("rejects empty attributes", async () => {
    const parsed = setEmailAttributesInput.safeParse({
      account: "work",
      mailbox: "INBOX",
      uids: [94],
      attributes: {},
    });

    expect(parsed.success).toBe(false);
  });

  /* REQUIREMENT end:comm/email-client-mcp/tools -- set_email_attributes is discoverable for mail management */
  it("registers set_email_attributes with connected-tool examples", async () => {
    const registered: Array<{ name: string; config: { description?: string } }> = [];
    const server = {
      registerTool: (name: string, config: { description?: string }) => {
        registered.push({ name, config });
      },
    };

    registerTools(server as never, {
      accounts: [],
      imapPool: {} as never,
      watcher: {} as never,
      bodyHydration: {} as never,
      attachmentHydration: {} as never,
      messageMirror: buildMirror(),
    });

    const tool = registered.find((item) => item.name === "set_email_attributes");
    expect(tool?.config.description).toContain("read/unread");
    expect(tool?.config.description).toContain("flagged/unflagged");
    expect(tool?.config.description).toContain("find_mailbox_folder");
  });
});

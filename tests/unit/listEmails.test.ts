import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../src/domain/result.js";
import type { ImapPool } from "../../src/imap/pool.js";
import { listEmails, listEmailsInput } from "../../src/tools/listEmails.js";

type FakeClient = {
  readonly getMailboxLock: ReturnType<typeof vi.fn>;
  readonly search: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
};

/** Build the minimal IMAP pool needed to verify native text-term search composition. */
const buildPool = (client: FakeClient): ImapPool => ({
  accountIds: ["google__aileron"],
  forAccount: vi.fn(async () => Ok(client as never)),
  closeAll: vi.fn(async () => undefined),
});

describe("listEmails", () => {
  /* REQ-2912-3: Native inbox search intersects generic text terms and returns attachment-aware envelopes without hydrating bodies. */
  it("intersects IMAP text terms before fetching the matching envelope page", async () => {
    const release = vi.fn();
    const client: FakeClient = {
      getMailboxLock: vi.fn(async () => ({ release })),
      search: vi.fn(async (query: { readonly text?: string }) =>
        query.text === "Luna" ? [20, 30] : [20, 40],
      ),
      fetch: vi.fn(async function* () {
        yield {
          uid: 20,
          flags: new Set<string>(),
          envelope: {
            subject: "New pricing and Fast mode for Sol",
            from: [{ name: "OpenAI", address: "team@openai.com" }],
            to: [],
            cc: [],
            date: new Date("2026-07-31T00:02:32.000Z"),
          },
          bodyStructure: {
            type: "multipart/mixed",
            childNodes: [
              {
                type: "application/pdf",
                part: "2",
                disposition: "attachment",
                dispositionParameters: { filename: "pricing.pdf" },
                size: 123,
              },
            ],
          },
          internalDate: new Date("2026-07-31T00:02:32.000Z"),
        };
      }),
    };
    const parsed = listEmailsInput.safeParse({
      account: "google__aileron",
      mailbox: "INBOX",
      pageSize: 20,
      textTerms: ["Luna", "pricing"],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = await listEmails(buildPool(client), parsed.data);

    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(client.search).toHaveBeenNthCalledWith(1, { text: "Luna" }, { uid: true });
    expect(client.search).toHaveBeenNthCalledWith(2, { text: "pricing" }, { uid: true });
    expect(result.value.items).toEqual([
      expect.objectContaining({ uid: 20, hasAttachments: true }),
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});

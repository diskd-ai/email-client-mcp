import { describe, expect, it } from "vitest";
import {
  outboxCreatedSubject,
  parseOutboxCreatedEvent,
} from "../../src/delivery/infrastructure/outboxEvent.js";

const event = {
  id: "2867e00785a92ca1e2420d45e12d8207885d70066f4c31025d03e6faf376ce05",
  type: "exchange.outbox.created",
  workspace_id: "ws_01",
  timestamp: "2026-08-29T08:00:00.000Z",
  version: 1,
  data: {
    account: "work",
    mailboxId: "exchange-work",
    externalId: "lead-1",
    revision: "2",
  },
};

describe("delivery/infrastructure/outboxEvent", () => {
  /* REQ-DELIVERY-024: The consumer subject is scoped to exactly one workspace. */
  it("builds the canonical workspace Outbox subject", () => {
    expect(outboxCreatedSubject("ws_01")).toBe("platform.ws_01.exchange.outbox.created");
  });

  /* REQ-DELIVERY-013: A frozen locator-only Outbox event is validated and normalized. */
  it("parses the canonical Outbox event envelope", () => {
    expect(parseOutboxCreatedEvent(event, "ws_01")).toEqual({
      tag: "Ok",
      value: {
        eventId: event.id,
        workspaceId: "ws_01",
        occurredAt: "2026-08-29T08:00:00.000Z",
        account: "work",
        mailboxId: "exchange-work",
        externalId: "lead-1",
        revision: "2",
      },
    });
  });

  /* REQ-DELIVERY-014: Events from another workspace cannot reach item lookup. */
  it("rejects a different workspace", () => {
    expect(parseOutboxCreatedEvent(event, "ws_02")).toEqual({
      tag: "Err",
      error: {
        kind: "WrongWorkspace",
        expectedWorkspaceId: "ws_02",
        actualWorkspaceId: "ws_01",
      },
    });
  });

  /* REQ-DELIVERY-015: Event identity must match Drive's deterministic event contract. */
  it("rejects a mismatched deterministic event ID", () => {
    const result = parseOutboxCreatedEvent({ ...event, id: "0".repeat(64) }, "ws_01");

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.kind).toBe("EventIdMismatch");
  });

  /* REQ-DELIVERY-016: Message content and unknown envelope fields are refused. */
  it("rejects non-locator event content", () => {
    const result = parseOutboxCreatedEvent({ ...event, body: "must not cross the event" }, "ws_01");

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.kind).toBe("InvalidEvent");
  });
});

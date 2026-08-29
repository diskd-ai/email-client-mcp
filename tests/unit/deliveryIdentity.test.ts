import { describe, expect, it } from "vitest";
import {
  type DeliveryAccountIdentity,
  resolveDeliveryIdentity,
} from "../../src/delivery/domain/identity.js";

const accounts: readonly DeliveryAccountIdentity[] = [
  { accountId: "work", allowedFromAddresses: ["work@example.com", "sales@example.com"] },
  { accountId: "personal", allowedFromAddresses: ["person@example.com"] },
];

describe("delivery/domain/identity", () => {
  /* REQ-DELIVERY-006: Account selector and From address are distinct verified identities. */
  it("normalizes and resolves one authorized sender", () => {
    expect(resolveDeliveryIdentity(accounts, "work", " Work@Example.COM ")).toEqual({
      tag: "Ok",
      value: { accountId: "work", fromAddress: "work@example.com" },
    });
  });

  /* REQ-DELIVERY-007: A configured alias is authorized only for its owning account. */
  it("resolves an explicit allowed alias", () => {
    expect(resolveDeliveryIdentity(accounts, "work", "sales@example.com")).toEqual({
      tag: "Ok",
      value: { accountId: "work", fromAddress: "sales@example.com" },
    });
  });

  /* REQ-DELIVERY-008: Missing, duplicate, and unauthorized identities fail before SMTP. */
  it.each([
    {
      name: "missing account",
      configured: accounts,
      accountId: "missing",
      fromAddress: "work@example.com",
      errorKind: "AccountNotFound",
    },
    {
      name: "duplicate account",
      configured: [...accounts, accounts[0]],
      accountId: "work",
      fromAddress: "work@example.com",
      errorKind: "AmbiguousAccount",
    },
    {
      name: "unauthorized sender",
      configured: accounts,
      accountId: "work",
      fromAddress: "person@example.com",
      errorKind: "UnauthorizedFromIdentity",
    },
    {
      name: "empty sender",
      configured: accounts,
      accountId: "work",
      fromAddress: "  ",
      errorKind: "InvalidFromIdentity",
    },
  ])("rejects $name", ({ configured, accountId, fromAddress, errorKind }) => {
    const result = resolveDeliveryIdentity(configured, accountId, fromAddress);

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.kind).toBe(errorKind);
  });

  /* REQ-DELIVERY-009: The explicit account selector owns credential choice when sender addresses are shared. */
  it("resolves a sender address shared by accounts through the explicit selector", () => {
    const configured = [
      ...accounts,
      { accountId: "shared", allowedFromAddresses: ["WORK@example.com"] },
    ];

    expect(resolveDeliveryIdentity(configured, "work", "work@example.com")).toEqual({
      tag: "Ok",
      value: { accountId: "work", fromAddress: "work@example.com" },
    });
  });
});

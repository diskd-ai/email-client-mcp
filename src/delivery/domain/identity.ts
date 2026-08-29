import { Err, Ok, type Result } from "../../domain/result.js";

export type DeliveryAccountIdentity = {
  readonly accountId: string;
  readonly allowedFromAddresses: readonly string[];
};

export type ResolvedDeliveryIdentity = {
  readonly accountId: string;
  readonly fromAddress: string;
};

export type DeliveryIdentityError =
  | { readonly kind: "AccountNotFound"; readonly accountId: string }
  | { readonly kind: "AmbiguousAccount"; readonly accountId: string }
  | { readonly kind: "InvalidFromIdentity" }
  | {
      readonly kind: "UnauthorizedFromIdentity";
      readonly accountId: string;
      readonly fromAddress: string;
    };

export const normalizeEmailAddress = (address: string): string => address.trim().toLowerCase();

const hasFromAddress = (account: DeliveryAccountIdentity, fromAddress: string): boolean =>
  account.allowedFromAddresses.some(
    (allowedAddress) => normalizeEmailAddress(allowedAddress) === fromAddress,
  );

/** Resolve one configured connector and authorize its sender identity. */
export const resolveDeliveryIdentity = (
  accounts: readonly DeliveryAccountIdentity[],
  accountId: string,
  fromAddress: string,
): Result<DeliveryIdentityError, ResolvedDeliveryIdentity> => {
  const matchingAccounts = accounts.filter((account) => account.accountId === accountId);
  if (matchingAccounts.length === 0) return Err({ kind: "AccountNotFound", accountId });
  if (matchingAccounts.length > 1) return Err({ kind: "AmbiguousAccount", accountId });

  const normalizedFromAddress = normalizeEmailAddress(fromAddress);
  if (normalizedFromAddress.length === 0) return Err({ kind: "InvalidFromIdentity" });

  const selectedAccount = matchingAccounts[0];
  if (selectedAccount === undefined || !hasFromAddress(selectedAccount, normalizedFromAddress)) {
    return Err({
      kind: "UnauthorizedFromIdentity",
      accountId,
      fromAddress: normalizedFromAddress,
    });
  }

  return Ok({ accountId, fromAddress: normalizedFromAddress });
};

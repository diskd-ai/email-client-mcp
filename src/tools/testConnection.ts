import * as nodemailer from "nodemailer";
import { z } from "zod";
import type { Account } from "../config/schema.js";
import { buildSmtpConnectionOptions } from "../delivery/infrastructure/smtpTransport.js";
import { type AppError, errorMessage, notFound } from "../domain/errors.js";
import { Err, Ok, type Result } from "../domain/result.js";
import type { ImapPool } from "../imap/pool.js";

export const testConnectionInput = z.object({ account_name: z.string().trim().min(1) }).strict();

type ProtocolStatus =
  | { readonly status: "ok"; readonly latencyMs: number }
  | { readonly status: "error"; readonly error: string };

type ConnectionStatus = { readonly imap: ProtocolStatus; readonly smtp: ProtocolStatus };

/** Probe the live cached IMAP connection so Vault can distinguish configuration from reachability. */
const probeImap = async (pool: ImapPool, accountName: string): Promise<ProtocolStatus> => {
  const started = performance.now();
  try {
    const connection = await pool.forAccount(accountName);
    if (connection.tag === "Err") return { status: "error", error: errorMessage(connection.error) };
    await connection.value.noop();
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (cause) {
    return { status: "error", error: cause instanceof Error ? cause.message : String(cause) };
  }
};

/** Authenticate SMTP without sending mail, using the same owner configuration as delivery. */
const probeSmtp = async (account: Account): Promise<ProtocolStatus> => {
  if (!account.smtp) return { status: "error", error: "SMTP settings are not configured" };
  const started = performance.now();
  try {
    const transport = nodemailer.createTransport(buildSmtpConnectionOptions(account, account.smtp));
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (cause) {
    return { status: "error", error: cause instanceof Error ? cause.message : String(cause) };
  }
};

/** Fulfil Vault's existing account_name contract with independent IMAP and SMTP outcomes. */
export const testConnection = async (
  pool: ImapPool,
  accounts: readonly Account[],
  input: z.infer<typeof testConnectionInput>,
): Promise<Result<AppError, ConnectionStatus>> => {
  const account = accounts.find((candidate) => candidate.name === input.account_name);
  if (!account) return Err(notFound(`account ${input.account_name}`));
  const [imap, smtp] = await Promise.all([probeImap(pool, account.name), probeSmtp(account)]);
  return Ok({ imap, smtp });
};

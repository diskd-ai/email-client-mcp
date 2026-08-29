import { createHash } from "node:crypto";
import type { EmailOutboxPayload } from "@diskd-ai/sdk";
import * as nodemailer from "nodemailer";
import { z } from "zod";
import { type Account, isOAuthAccount, type SmtpSettings } from "../../config/schema.js";
import type { TransportOutcome } from "../domain/transportOutcome.js";

const CONNECTION_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 60_000;

type PasswordSmtpAuth = {
  readonly type: "login";
  readonly user: string;
  readonly pass: string;
};

type OAuthSmtpAuth = {
  readonly type: "OAuth2";
  readonly user: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
};

export type SmtpConnectionOptions = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly tls: { readonly rejectUnauthorized: boolean };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
  readonly auth: PasswordSmtpAuth | OAuthSmtpAuth;
};

export type SmtpMessage = {
  readonly payload: EmailOutboxPayload;
  readonly fromAddress: string;
  readonly fromName: string;
};

export type SmtpSender = {
  readonly send: (message: SmtpMessage) => Promise<TransportOutcome>;
  readonly close: () => void;
};

const smtpErrorSchema = z
  .object({
    message: z.string().optional(),
    code: z.string().optional(),
    command: z.string().optional(),
    response: z.string().optional(),
    responseCode: z.number().int().optional(),
    syscall: z.string().optional(),
  })
  .passthrough();

type SmtpFailureDetails = z.infer<typeof smtpErrorSchema>;

const formatFailureReason = (details: SmtpFailureDetails, fallback: string): string =>
  [details.code, details.command, details.response, details.message ?? fallback]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(": ");

const rejectionKind = (responseCode: number | undefined): "Transient" | "Permanent" =>
  responseCode !== undefined && responseCode >= 400 && responseCode < 500
    ? "Transient"
    : "Permanent";

const hasDefinitiveSmtpResponse = (details: SmtpFailureDetails): boolean =>
  details.responseCode !== undefined && details.responseCode >= 400 && details.responseCode < 600;

const isPreSubmissionCommand = (command: string | undefined): boolean =>
  command === "CONN" ||
  command === "EHLO" ||
  command === "HELO" ||
  command?.startsWith("AUTH ") === true ||
  command === "MAIL FROM" ||
  command === "RCPT TO" ||
  command === "API";

/** Classify only failures proven to occur before SMTP acceptance as retryable. */
export const classifySmtpFailure = (cause: unknown): TransportOutcome => {
  const parsed = smtpErrorSchema.safeParse(cause);
  const fallback = cause instanceof Error ? cause.message : String(cause);
  if (!parsed.success) {
    return { kind: "UnknownOutcome", failure: { reason: fallback } };
  }

  const details = parsed.data;
  const reason = formatFailureReason(details, fallback);
  if (details.code === "EAUTH" || details.code === "EREQUIRETLS") {
    return {
      kind: "RejectedBeforeAcceptance",
      rejection: { kind: "Permanent", failure: { reason } },
    };
  }
  if (hasDefinitiveSmtpResponse(details)) {
    return {
      kind: "RejectedBeforeAcceptance",
      rejection: {
        kind: rejectionKind(details.responseCode),
        failure: { reason },
      },
    };
  }
  if (details.syscall === "connect") {
    return {
      kind: "RejectedBeforeAcceptance",
      rejection: { kind: "Transient", failure: { reason } },
    };
  }
  if (details.code === "EENVELOPE" && isPreSubmissionCommand(details.command)) {
    return {
      kind: "RejectedBeforeAcceptance",
      rejection: { kind: "Permanent", failure: { reason } },
    };
  }
  return { kind: "UnknownOutcome", failure: { reason } };
};

export const buildSmtpConnectionOptions = (
  account: Account,
  smtp: SmtpSettings,
): SmtpConnectionOptions => ({
  host: smtp.host,
  port: smtp.port,
  secure: smtp.tls,
  requireTLS: smtp.starttls,
  tls: { rejectUnauthorized: smtp.verify_ssl },
  connectionTimeout: CONNECTION_TIMEOUT_MS,
  greetingTimeout: GREETING_TIMEOUT_MS,
  socketTimeout: SOCKET_TIMEOUT_MS,
  auth: isOAuthAccount(account)
    ? {
        type: "OAuth2",
        user: account.username ?? account.email,
        clientId: account.oauth2.client_id,
        clientSecret: account.oauth2.client_secret,
        refreshToken: account.oauth2.refresh_token,
      }
    : {
        type: "login",
        user: account.username ?? account.email,
        pass: account.password,
      },
});

export const toSmtpMessageId = (messageId: string): string =>
  `<${createHash("sha256").update(messageId, "utf8").digest("hex")}@email-client-mcp.invalid>`;

const readSmtpAddress = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  const parsed = z.object({ address: z.string() }).safeParse(value);
  return parsed.success ? parsed.data.address : undefined;
};

const normalizeSmtpAddresses = (values: readonly unknown[]): readonly string[] =>
  values.flatMap((value) => {
    const address = readSmtpAddress(value);
    return address === undefined ? [] : [address];
  });

export const buildSmtpSender = (account: Account): SmtpSender => {
  if (account.smtp === undefined) {
    throw new Error(`SMTP settings missing for account: ${account.name}`);
  }
  const transport = nodemailer.createTransport(buildSmtpConnectionOptions(account, account.smtp));

  return {
    send: async (message) => {
      try {
        const info = await transport.sendMail({
          messageId: toSmtpMessageId(message.payload.messageId),
          from: { name: message.fromName, address: message.fromAddress },
          to: [...message.payload.to],
          cc: [...message.payload.cc],
          bcc: [...message.payload.bcc],
          subject: message.payload.subject,
          text: message.payload.bodyText,
          html: message.payload.bodyHtml || undefined,
          inReplyTo: message.payload.inReplyTo ?? undefined,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return {
          kind: "Accepted",
          receipt: {
            messageId: info.messageId,
            accepted: normalizeSmtpAddresses(info.accepted),
            rejected: normalizeSmtpAddresses(info.rejected),
            response: info.response,
          },
        };
      } catch (cause) {
        return classifySmtpFailure(cause);
      }
    },
    close: () => transport.close(),
  };
};

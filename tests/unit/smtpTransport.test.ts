import { describe, expect, it } from "vitest";
import {
  buildSmtpConnectionOptions,
  classifySmtpFailure,
  composeRawMessage,
  toSmtpMessageId,
} from "../../src/delivery/infrastructure/smtpTransport.js";

const smtp = {
  host: "smtp.example.com",
  port: 587,
  tls: false,
  starttls: true,
  verify_ssl: true,
};

describe("delivery/infrastructure/smtpTransport", () => {
  /* REQ-DELIVERY-032: Password SMTP uses the configured account identity and TLS policy. */
  it("builds password SMTP options", () => {
    const options = buildSmtpConnectionOptions(
      {
        name: "work",
        email: "agent@example.com",
        username: "smtp-user",
        password: "secret",
        imap: { host: "imap.example.com", port: 993, tls: true, verify_ssl: true },
        smtp,
      },
      smtp,
    );

    expect(options).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      auth: { type: "login", user: "smtp-user", pass: "secret" },
    });
  });

  /* REQ-DELIVERY-033: OAuth SMTP derives credentials from the configured connector only. */
  it("builds OAuth SMTP options", () => {
    const options = buildSmtpConnectionOptions(
      {
        name: "gmail",
        email: "agent@gmail.com",
        oauth2: {
          provider: "gmail",
          client_id: "client",
          client_secret: "secret",
          refresh_token: "refresh",
        },
        imap: { host: "imap.gmail.com", port: 993, tls: true, verify_ssl: true },
        smtp,
      },
      smtp,
    );

    expect(options.auth).toEqual({
      type: "OAuth2",
      user: "agent@gmail.com",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
  });

  /* REQ-DELIVERY-034: A transient pre-acceptance failure is safe to retry. */
  it("classifies connection refusal before SMTP submission as transient", () => {
    expect(
      classifySmtpFailure({
        message: "connect refused",
        code: "ESOCKET",
        command: "CONN",
        syscall: "connect",
      }),
    ).toMatchObject({
      kind: "RejectedBeforeAcceptance",
      rejection: { kind: "Transient" },
    });
  });

  /* REQ-DELIVERY-035: Authentication rejection is terminal before acceptance. */
  it("classifies authentication failure as permanent", () => {
    expect(
      classifySmtpFailure({ message: "invalid login", code: "EAUTH", command: "AUTH XOAUTH2" }),
    ).toMatchObject({
      kind: "RejectedBeforeAcceptance",
      rejection: { kind: "Permanent" },
    });
  });

  /* REQ-DELIVERY-036: A transport loss without a provable SMTP rejection is terminal unknown. */
  it("classifies a lost response after DATA as unknown", () => {
    expect(
      classifySmtpFailure({ message: "socket closed", code: "ECONNECTION", command: "DATA" }),
    ).toMatchObject({ kind: "UnknownOutcome" });
  });

  /* REQ-DELIVERY-044: Nodemailer's generic CONN label does not prove that submission never started. */
  it("classifies an unscoped connection loss as unknown", () => {
    expect(
      classifySmtpFailure({
        message: "connection closed unexpectedly",
        code: "ECONNECTION",
        command: "CONN",
      }),
    ).toMatchObject({ kind: "UnknownOutcome" });
  });

  /* REQ-DELIVERY-037: SMTP retries reuse one deterministic RFC message identifier. */
  it("derives a stable RFC message id", () => {
    expect(toSmtpMessageId("review-1")).toBe(toSmtpMessageId("review-1"));
    expect(toSmtpMessageId("review-1")).toMatch(/^<[a-f0-9]{64}@email-client-mcp\.invalid>$/);
  });

  /* REQ-DELIVERY-053: SMTP and IMAP reuse one RFC822 message containing hydrated attachments. */
  it("composes one RFC822 message with the canonical Message-ID and attachment bytes", async () => {
    const raw = await composeRawMessage({
      payload: {
        messageId: "review-1",
        account: "work",
        threadId: null,
        inReplyTo: null,
        from: { name: "Agent", address: "agent@example.com" },
        to: [{ name: "Lead", address: "lead@example.com" }],
        cc: [],
        bcc: [],
        subject: "Viewing request",
        bodyText: "Hello",
        bodyHtml: "",
        hasAttachments: true,
        attachments: [
          {
            path: "/Projects/acme/contract.pdf",
            filename: "contract.pdf",
            contentType: "application/pdf",
          },
        ],
      },
      attachments: [
        {
          filename: "contract.pdf",
          contentType: "application/pdf",
          content: Buffer.from("pdf-bytes"),
        },
      ],
      fromAddress: "agent@example.com",
      fromName: "Agent",
    });
    const message = raw.toString("utf8");
    const unfoldedMessage = message.replace(/\r\n[ \t]+/g, " ");

    expect(unfoldedMessage).toContain(`Message-ID: ${toSmtpMessageId("review-1")}`);
    expect(message).toContain("Content-Type: application/pdf");
    expect(message).toContain("filename=contract.pdf");
    expect(message).toContain("cGRmLWJ5dGVz");
  });
});

# LOG

## 2026-08-29

- `end:comm/email-client-mcp/delivery`: deliver approved Exchange Outbox email through bounded Drive reconciliation and configured SMTP without NATS access in the dynamic MCP namespace, preserving the pre-send marker that makes ambiguous provider outcomes terminal `FailedUnknown`.
- `end:comm/email-client-mcp/sync`: emit locator-only `exchange.inbox.created` notifications through the MCP protocol so trusted mcp-hub infrastructure owns NATS publication and app-service can re-read canonical Drive state.

## 2026-08-28

- `end:comm/email-client-mcp/delivery`: establish the pure outbound delivery lifecycle, retry-safety decisions, sender identity authorization, and optional per-account SMTP configuration so later Exchange integration cannot retry ambiguous submissions or conflate connector identity with the From address.

## 2026-08-10

- `end:comm/email-client-mcp/sync`: persist ImapFlow's provider hierarchy delimiter with every folder sync checkpoint so downstream Inbox queries can distinguish real descendants from same-prefix sibling folders (Redmine 2910).

## 2026-08-09

- `end:comm/email-client-mcp/release`: publish from the repository's npm Trusted Publisher identity without a long-lived write token, preventing OTP-gated legacy authentication from blocking releases.

## 2026-08-08

- `end:comm/email-client-mcp/sync`: preserve each configured mailbox email as opaque Drive metadata while keeping `displayName` human-readable, and refresh missing metadata for existing mailboxes so downstream search uses explicit identity instead of parsing labels (Redmine 3066).

## 2026-08-05

- `end:comm/email-client-mcp`: adopted `@diskd-ai/sdk` 6.0.2 so the ingestion-side consumer stays aligned with the published unique mailbox search contract used by downstream workers (Redmine 3056).

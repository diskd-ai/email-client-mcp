# email-client-mcp -- Agent Instructions

Address: `end:comm/email-client-mcp`. Drive-backed email MCP server with reliable IMAP-to-mailboxes sync.

## What this server does

- Spawned by mcp-hub via `npx -y @diskd-ai/email-client-mcp stdio`.
- Reads accounts + Drive SDK config from a TOML file mounted by the
  `diskd-ai/email-client-mcp` vault assembler at
  `/home/mcp/.config/email-client-mcp/config.toml` (or `$EMAIL_CLIENT_MCP_CONFIG`).
- All tool reads (list/get/find) hit IMAP live. Watcher mirrors all configured
  accounts into Drive `messagesStore` (mailbox -> folder -> message) on a tick
  interval clamped to >=60s.

## Reliability invariants (do not regress)

1. `lastSyncedUid` only advances after a successful `upsertBatch` -- batches are idempotent on `externalId`.
2. `externalId` format is `${UIDVALIDITY}:${UID}` so UIDVALIDITY rollover never collides with old ids.
3. Per-account in-flight lock: the watcher never runs two ticks for the same account concurrently.
4. UIDVALIDITY mismatch on a folder triggers full drop+resync of that folder.
5. Tools never read from the store; the store is a write-only mirror in this server.

## Layout

```
src/
  server.ts           # stdio entry
  config/             # TOML schema + loader
  sdk/                # @diskd/sdk wrapper
  imap/               # imapflow pool + pure mapper + virtual-folder allowlist
  store/              # drive messagesStore wrapper, conventions, payload type
  sync/               # runSyncOnce + watcher + backoff (the core)
  tools/              # one file per MCP tool
  domain/             # Result/Option + typed errors
tests/unit/           # pure-module tests; vitest
```

## Commands

```
bun install
bun run build        # tsc
bun run typecheck
bun run lint
bun run test         # vitest unit
bun run start        # node dist/server.js stdio (needs config TOML)
bun run dev          # tsx src/server.ts stdio (live)
```

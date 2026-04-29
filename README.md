# Email Client MCP

Multi-account email MCP server with reliable IMAP-to-mailboxes sync into a Drive-backed `messagesStore` (`@diskd-ai/sdk`). Read tools hit IMAP live; the watcher mirrors every configured account into the workspace store on an interval (>= 60s).

Address: `end:comm/email-client-mcp`.

## Install

```bash
npx -y @diskd-ai/email-client-mcp stdio
```

The server speaks Model Context Protocol over stdio. JSON-RPC on stdout; logs to stderr.

## Tools

All read tools fetch from IMAP live (BODY.PEEK, never silently flips `\Seen`):

- `list_accounts` -- enumerate configured accounts (config-only; no IMAP).
- `list_mailbox_folder` -- folders for an account, with optional unread counts and special-use flags.
- `find_mailbox_folder` -- resolve real folders containing a given Message-Id (use before `move_email` for Gmail virtuals).
- `list_emails` -- paginated metadata listing with filters (unread, flagged, from/to/subject, since).
- `get_email` -- single message by UID. Formats: `raw`, `text` (HTML stripped), `stripped` (also drops quoted replies + signatures). `markRead=true` opt-in.
- `get_emails` -- bulk variant of `get_email` (max 20).
- `move_email` -- IMAP MOVE between folders. Refuses virtual mailboxes (e.g. `[Gmail]/All Mail`).
- `bulk_action` -- `mark_read | mark_unread | flag | unflag | move | delete` over up to 100 UIDs.
- `get_watcher_status` -- in-memory snapshot of the sync watcher.

## Watcher reliability

The watcher synchronizes IMAP into the workspace `messagesStore` on every tick. Invariants:

1. `lastSyncedUid` advances **only** after a successful idempotent `upsertBatch`.
2. `externalId = "${UIDVALIDITY}:${UID}"` so a UIDVALIDITY rollover never collides with the previous generation.
3. UIDVALIDITY mismatch on a folder triggers a clean drop + resync.
4. Per-account in-flight lock: an overlapping tick is skipped, never queued.
5. Folder metadata is the durable checkpoint -- restart resumes from there, never from in-memory state.
6. Folders deleted in IMAP are pruned from Drive at the end of a tick.
7. Sliding-window flag reconciliation bounds drift to `flag_reconcile_window` UIDs per tick.

Tick interval is clamped to >= 60s.

## Configuration

Default path: `~/.config/email-client-mcp/config.toml` (override via `EMAIL_CLIENT_MCP_CONFIG`). When deployed by mcp-hub the file is mounted by the `diskd-ai/email-client-mcp` vault assembler.

```toml
[sdk]
api_key = "..."
base_url = "https://apis.example/"
# workspace_id falls back to MCP_HUB_WORKSPACE_ID env when omitted.

[watcher]
enabled = true
interval_ms = 60000
flag_reconcile_window = 500
# folders = ["INBOX", "Sent"]   # optional allowlist; empty = all

[[accounts]]
name = "work"
email = "you@example.com"
full_name = "You"
password = "..."

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true
verify_ssl = false
```

For Gmail OAuth accounts, replace the `password` field with an `[accounts.oauth2]` block:

```toml
[[accounts]]
name = "gmail-work"
email = "you@gmail.com"
full_name = "You"

[accounts.oauth2]
provider = "google"
client_id = "..."
client_secret = "..."
refresh_token = "..."

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true
verify_ssl = false
```

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test          # vitest unit tests
bun run build         # tsc -> dist/
bun run start         # node dist/server.js stdio (needs config TOML)
bun run dev           # tsx src/server.ts stdio (live reload)

# stdio smoke test (initialize + tools/list + tool calls):
node scripts/smoke.mjs
```

## Releasing

Auto-publish via `.github/workflows/release.yml`:

- **Tag-driven** (preferred): `npm version patch && git push --follow-tags` from main; the `v*.*.*` tag triggers the workflow which typechecks, lints, tests, builds, and `npm publish`es.
- **One-click**: in the GitHub Actions UI run the *Release* workflow with `bump = patch | minor | major`. The job bumps `package.json`, commits, tags, pushes, and publishes -- all in one job.

Both paths run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build` before publishing, with provenance attestation enabled.

Required repo secret:

| Secret | Purpose |
| --- | --- |
| `NPM_TOKEN` | npmjs.com granular token, scope `@diskd-ai/*`, **Bypass 2FA** enabled. |

## License

LGPL-3.0-or-later. See `LICENSE`.

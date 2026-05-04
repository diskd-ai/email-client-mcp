Fast Email Index and Lazy Content Hydration Design Doc
======================================================

Context and motivation
----------------------

`email-client-mcp` currently mirrors IMAP mailboxes into Drive `messagesStore` with a heavy per-message pipeline: fetch envelope/body structure, fetch display body parts, write message, download every attachment, upload attachments to Drive, then write the final message payload. This makes initial sync slow and couples mailbox progress to the most expensive and failure-prone operations.

Recent production/dev symptoms show why this must change:

- Large attachment uploads can hit APIS/Drive limits and timeouts.
- Gmail IMAP can throttle `BODY.PEEK[...]` and attachment fetches with `Some messages could not be FETCHed (Failure) [THROTTLED]`.
- A single body/attachment failure can block the folder checkpoint because `lastSyncedUid` only advances after the full message and all attachments are durable.
- Agent use cases need fast broad discovery first, then selective deep reads.

The new design separates mailbox indexing from content hydration:

```text
fast metadata index -> body hydration cache -> explicit attachment hydration
```

Goals:

- Make initial mailbox visibility fast, especially for large Gmail accounts.
- Keep mailbox sync progress independent from body and attachment failures.
- Never upload attachment bytes during background watcher sync.
- Support agent tasks such as “analyze correspondence with sender X” without forcing one MCP call per message.
- Keep Drive `messagesStore` as the Exchange/read model cache for indexed metadata and hydrated content.
- Keep public attachment handles based on `attachmentId`, never `driveInode`.
- Treat Gmail/IMAP throttling as retryable content-hydration state, not a process crash.

Non-goals for first implementation (v1):

- No full-text search index over bodies in v1. Body search can be added after body hydration stabilizes.
- No automatic background attachment download in v1.
- No global cross-workspace Gmail rate limiter in v1.
- No Drive-side knowledge of Vault account state, Exchange semantics, or agent workflows.
- No binary attachment content returned directly in MCP responses.
- No migration that rewrites all historical message payloads eagerly; legacy payloads are interpreted compatibly at read time.

Implementation considerations
-----------------------------

Current source constraints:

- `src/sync/sync.ts` owns watcher sync invariants and currently advances `lastSyncedUid` after full message + attachment persistence.
- `src/imap/fetch.ts` currently has `fetchUidRange()` that fetches envelope/bodyStructure first and then fetches display bodies for every message.
- `src/imap/mapper.ts` builds `StoredEmailPayload` and currently derives attachment metadata from `bodyStructure`.
- `src/store/driveStore.ts` wraps Drive `messagesStore` and attachment upload APIs.
- `src/tools/getEmail.ts` already supports live single-message body fetch without attachment upload.
- Repository invariant says tools currently read IMAP live and the store is a write-only mirror. This design intentionally changes that for new hydration tools: tools may read/update `messagesStore` as a content cache when explicitly implemented.

Design principles:

- Metadata checkpoint safety: a folder checkpoint advances after durable metadata upsert, not after body or attachments.
- Content hydration isolation: body and attachment states are independent retryable sub-states on each stored message.
- Recent-first UX: new and recent mail appears before historical archive backfill completes.
- Batch over chatty calls: agent hydration tools accept multiple message references.
- Best-effort body cache: eager body loading improves common UX but never blocks indexing.
- Attachments explicit only: attachment bytes move only after a user/agent asks for a specific attachment.
- Backward-compatible reads: missing new state fields are normalized without rewriting old records.

High-level behavior
-------------------

The watcher performs two classes of work.

1. Metadata indexing:

   - For each account/folder, fetch IMAP metadata only:

     ```text
     uid
     flags
     labels, when available
     envelope
     bodyStructure
     internalDate
     ```

   - Do not fetch display body parts.
   - Do not call `client.download()`.
   - Do not call Drive attachment upload.
   - Persist a skeleton `StoredEmailPayload` to `messagesStore`.
   - Advance metadata checkpoint after successful message metadata upsert.

2. Optional body hydration:

   - After metadata is indexed, the watcher may hydrate bodies for a bounded recent window.
   - Hydration fetches `text/plain` and/or `text/html` display parts only.
   - Hydration updates `bodyText`, `bodyHtml`, `snippet`, `bodyState`, and diagnostics.
   - Hydration failures never roll back metadata checkpoint.

Attachments are handled only by explicit tools/API flows:

- Attachment metadata is indexed from `bodyStructure` and contains deterministic `attachmentId` plus IMAP `partId`.
- Attachment bytes remain absent until `load_email_attachment` or equivalent UI/API action runs.
- On explicit load, the server fetches exactly one IMAP body part, uploads it to Drive `messagesStore`, and patches only that attachment state.

Agent correspondence analysis flow:

1. Agent searches/list candidates by metadata: sender, recipients, dates, folders, subject, `bodyState`, `hasAttachments`.
2. Agent receives candidate refs and cache state:

   ```json
   {
     "account": "google__work",
     "mailbox": "INBOX",
     "uid": 123,
     "externalId": "14:123",
     "subject": "...",
     "date": "...",
     "bodyState": "loaded",
     "snippet": "..."
   }
   ```

3. Agent analyzes already-loaded bodies immediately.
4. For missing bodies, agent calls a batch hydration tool, not one `get_email` per message.
5. For large candidate sets, agent processes in chunks and summarizes incrementally.
6. Attachments are loaded only when the analysis specifically needs an attachment.

Data model
----------

`StoredEmailPayload` remains opaque JSON to Drive. The owning schema in `email-client-mcp` is extended compatibly.

Message payload v2 fields:

```ts
type BodyState =
  | "not_loaded"
  | "loading"
  | "loaded"
  | "failed_retryable"
  | "failed_permanent";

type AttachmentStorageState =
  | "not_loaded"
  | "loading"
  | "loaded"
  | "failed_retryable"
  | "failed_permanent";

type StoredEmailPayload = {
  accountId: string;
  mailbox: string;
  uid: number;
  uidValidity: number;

  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  from: EmailAddress | null;
  to: readonly EmailAddress[];
  cc: readonly EmailAddress[];
  subject: string;
  date: string;
  flags: readonly string[];
  labels: readonly string[];

  hasAttachments: boolean;
  attachments: readonly StoredAttachment[];

  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  truncated: boolean;
  bodyState: BodyState;
  bodyFetchedAt: string | null;
  bodyFetchError: string | null;

  fetchedAt: string;
};

type StoredAttachment = {
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  partId: string;
  storageState: AttachmentStorageState;
  storedSizeBytes?: number;
  storedAt?: string;
  lastLoadError?: string;
};
```

Compatibility rules:

- If `bodyState` is absent and `bodyText` or `bodyHtml` is present, read as `loaded`.
- If `bodyState` is absent and both body fields are null, read as `not_loaded`.
- If attachment `storageState` is absent and `storedAt` is present, read as `loaded`.
- If attachment `storageState` is absent and `storedAt` is absent, read as `not_loaded`.
- `attachmentId` is generated deterministically from `(uidValidity, uid, partId)` using the existing attachment-id convention helper, so the same attachment is addressable before and after bytes are stored.

Sync state model
----------------

The current `SyncState` has one forward checkpoint:

```ts
lastSyncedUid: number;
```

v1 of the new implementation may keep this field for forward-only metadata indexing while removing body/attachment coupling.

The target recent-first model adds separate forward and historical cursors:

```ts
type SyncStateV2 = {
  uidValidity: number;
  uidNext: number;

  /** Highest UID durably metadata-indexed for new-mail forward sync. */
  forwardSyncedUid: number;

  /** Lowest UID already covered by historical backfill. */
  backfillBeforeUid: number | null;

  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  lastSyncError: string | null;

  lastBodyHydrationStartedAt?: string | null;
  lastBodyHydrationFinishedAt?: string | null;
  lastBodyHydrationError?: string | null;
};
```

Recent-first behavior:

- On an empty folder state, read `uidNext` from `folderStatus()`.
- Index the latest `initialRecentWindow` UID range first:

  ```text
  from = max(1, uidNext - initialRecentWindow)
  to = uidNext - 1
  ```

- Set:

  ```text
  forwardSyncedUid = to
  backfillBeforeUid = from
  ```

- On each later tick:
  1. index new forward range `forwardSyncedUid + 1 .. uidNext - 1`;
  2. run one bounded historical backfill window before `backfillBeforeUid`;
  3. run bounded body hydration for eligible recent indexed messages;
  4. run bounded flag reconciliation.

Folder priority:

```text
1. INBOX
2. Sent
3. Important/Starred, when exposed as real folders
4. Other user folders
5. Gmail All Mail, low priority and no eager body hydration in v1
```

Body hydration policy
---------------------

Body hydration is a cache-fill operation. It may run from the watcher or explicit tools.

Recommended defaults:

```ts
const BODY_HYDRATION_DEFAULTS = {
  eagerEnabled: true,
  eagerRecentWindowMessages: 300,
  maxBodiesPerTick: 50,
  maxBodyPartBytes: 256_000,
  maxBodyBytesPerTick: 2_000_000,
  disableEagerForAllMail: true,
};
```

Eligibility for eager body hydration:

- Message is already metadata-indexed.
- `bodyState` is `not_loaded` or retryable cooldown has expired.
- Folder is eligible for eager body hydration.
- Message UID is within the recent eager window.
- Display body part sizes are known and within `maxBodyPartBytes`, when size is available from `bodyStructure`.
- Global tick budgets are not exhausted.

Hydration result mapping:

- Successful fetch and store:

  ```text
  bodyState = loaded
  bodyFetchedAt = now
  bodyFetchError = null
  snippet = text snippet from bodyText or html-to-text bodyHtml
  ```

- Gmail/IMAP throttling, network timeout, transient command failure:

  ```text
  bodyState = failed_retryable
  bodyFetchError = typed message
  ```

- Unsupported/malformed MIME that cannot be decoded after fallback:

  ```text
  bodyState = failed_permanent
  bodyFetchError = typed message
  ```

A message with `failed_retryable` body remains discoverable and analyzable by metadata. It can be retried by later eager hydration or explicit agent hydration.

Attachment hydration policy
---------------------------

Background sync never loads attachment bytes.

Attachment bytes are loaded only through an explicit operation that identifies exactly one attachment by public handle:

```ts
type LoadEmailAttachmentInput = {
  account: string;
  mailbox: string;
  uid: number;
  attachmentId: string;
  persist?: boolean; // default true
};
```

Operation behavior:

1. Resolve the stored message from `messagesStore` by `(mailboxId, folderId, externalId)`.
2. Find attachment by `attachmentId`.
3. Use its `partId` to fetch exactly that MIME part from IMAP.
4. Upload bytes to Drive `messagesStore` attachment storage when `persist=true`.
5. Patch that attachment metadata:

   ```text
   storageState = loaded
   storedSizeBytes = actual uploaded bytes
   storedAt = now
   lastLoadError = undefined
   ```

6. On retryable failure, patch only that attachment:

   ```text
   storageState = failed_retryable
   lastLoadError = typed message
   ```

The operation must not expose `driveInode` as the user/agent-facing attachment identity. Download APIs may internally use Drive storage references, but public callers use `attachmentId`.

MCP tool design
---------------

Existing tools remain available, but new tools should avoid one-message-at-a-time hydration for agent workflows.

New or revised tools:

### `search_emails`

Metadata/cache search over `messagesStore`.

Input:

```ts
type SearchEmailsInput = {
  account?: string;
  mailbox?: string;
  from?: string;
  to?: string;
  query?: string;      // v1: subject/address metadata only unless body already loaded
  since?: string;
  until?: string;
  hasAttachments?: boolean;
  bodyState?: "loaded" | "not_loaded" | "any";
  limit?: number;
  cursor?: string | null;
};
```

Output includes message refs, metadata, `bodyState`, snippet, and attachment metadata.

### `load_email_bodies`

Batch body hydration. This is the primary agent tool for correspondence analysis.

Input:

```ts
type LoadEmailBodiesInput = {
  messages: readonly {
    account: string;
    mailbox: string;
    uid: number;
  }[];
  persist?: boolean;       // default true
  format?: "raw" | "text" | "stripped";
  maxMessages?: number;    // capped by server, default 50
  maxTotalBytes?: number;  // capped by server
};
```

Output:

```ts
type LoadEmailBodiesResult = {
  loaded: readonly LoadedBodyResult[];
  skipped: readonly SkippedBodyResult[];
  failedRetryable: readonly FailedBodyResult[];
  failedPermanent: readonly FailedBodyResult[];
};
```

Rules:

- Server enforces maximum messages per call.
- Results are partial-success; one throttled message does not fail the whole call.
- Already-loaded messages can be returned from store without IMAP fetch.
- Missing or stale cached bodies can be fetched from IMAP and persisted.

### `get_full_email`

Single-message convenience wrapper.

Behavior:

- Return cached body from `messagesStore` if `bodyState=loaded` and `refresh=false`.
- Otherwise fetch display body parts from IMAP, update body state, and return result.
- Does not load attachment bytes.

### `load_email_attachment`

Load one attachment by `attachmentId` and persist it to Drive `messagesStore` attachment storage.

### `read_email_attachment`

Agent convenience for text-like attachments.

Rules:

- Refuses to inline large binary payloads.
- For unsupported binary content, returns a typed result instructing the agent to use `load_email_attachment` or save-to-Drive workflow.

Exchange/app-service behavior
-----------------------------

Exchange message list continues to read from `messagesStore` and displays metadata immediately.

Exchange message detail behavior should become cache-aware:

- If body is loaded, display it.
- If body is not loaded, either:
  - auto-trigger body hydration via backend/MCP and then refresh detail; or
  - show an explicit “Load full message” action in v1.

Exchange attachment behavior:

- Attachment rows can appear immediately from metadata.
- Attachment action calls explicit storage/hydration endpoint/tool by `attachmentId`.
- If attachment storage is not loaded, user sees loading/error state per attachment.

No frontend or backend public API should require `driveInode` for attachment access.

Error handling and UX
---------------------

Error categories:

- Retryable provider throttling:

  ```text
  Gmail THROTTLED
  IMAP transient command failure
  socket timeout
  temporary network failure
  ```

  Behavior: set `failed_retryable`, record error, schedule cooldown, do not crash process.

- Permanent content failure:

  ```text
  missing partId
  unsupported malformed MIME part
  attachmentId not found in bodyStructure
  ```

  Behavior: set `failed_permanent`, expose typed error to tool/UI.

- Drive/storage failure:

  ```text
  messagesStore upsert failed
  attachment upload failed
  ```

  Behavior: metadata sync surfaces folder error only when metadata write fails. Body/attachment storage errors update their own states and do not rewind metadata checkpoint.

- User/input error:

  ```text
  unknown account
  unknown mailbox
  unknown uid
  unknown attachmentId
  ```

  Behavior: return typed MCP error with actionable message.

Observability:

- Log metadata sync counts separately from body hydration counts and attachment hydration counts.
- Log retryable throttling with account/folder/uid but no sensitive message body.
- Watcher status exposes:

  ```text
  metadata progress
  body hydration progress/errors
  retry cooldowns
  attachment hydration is not part of watcher status unless requested in future
  ```

Update cadence / Lifecycle
--------------------------

Watcher tick lifecycle:

1. Acquire per-account in-flight lock.
2. List folders.
3. Ensure mailbox and folders exist in Drive.
4. Run metadata sync by folder priority.
5. Prune deleted folders after metadata sync.
6. Run bounded body hydration for eligible messages.
7. Run bounded flag reconciliation.
8. Persist sync state and emit watcher report.

Hydration lifecycle:

- Eager hydration runs opportunistically after metadata sync within strict budgets.
- Explicit hydration tools run immediately but enforce server caps.
- Retryable body/attachment states are retried only after cooldown.
- Permanent failures require explicit refresh or payload/state reset in a future admin/debug flow.

Future-proofing
---------------

This design leaves room for:

- Full-text indexing over hydrated bodies.
- Body hydration jobs persisted as a queue rather than opportunistic watcher work.
- Attachment text extraction pipeline for PDFs/docs/spreadsheets.
- User-configurable sync depth per account/folder.
- Provider-specific policies for Gmail, Exchange/IMAP, OVH, and others.
- Lazy attachment streaming directly to agent tool processors without first storing binary in Drive, when safe.
- Cross-message conversation/thread summaries stored as derived artifacts.

The important stable contract is the separation between:

```text
metadata indexed state
body hydration state
attachment storage state
```

Implementation outline
----------------------

### Phase 1: Metadata-only watcher path

Files:

- `src/imap/fetch.ts`
- `src/imap/mapper.ts`
- `src/store/payloadTypes.ts`
- `src/sync/sync.ts`
- `tests/unit/fetch.test.ts`
- `tests/unit/mapper.test.ts`
- `tests/unit/sync.test.ts`

Steps:

1. Add `fetchMetadataUidRange()` that fetches `uid`, `flags`, `envelope`, `bodyStructure`, `internalDate` only.
2. Keep `fetchDisplayBodies` available for explicit body hydration, not metadata indexing.
3. Extend payload types with `bodyState`, `bodyFetchedAt`, `bodyFetchError`, and attachment `storageState`.
4. Update mapper to produce skeleton payloads with deterministic `attachmentId`, `bodyState=not_loaded`, and attachment `storageState=not_loaded`.
5. Update `runSyncOnce()` to use metadata fetch for main sync.
6. Remove attachment download/upload from main sync path.
7. Advance checkpoint after metadata batch upsert.

### Phase 2: Retryable body hydration primitives

Files:

- `src/imap/fetch.ts`
- `src/sync/bodyHydration.ts` (new)
- `src/store/driveStore.ts`
- `src/domain/errors.ts`
- `tests/unit/fetch.test.ts`
- `tests/unit/bodyHydration.test.ts` (new)

Steps:

1. Add `fetchBodyByUid()` / `fetchBodiesByUidBatch()` for display body parts only.
2. Classify Gmail `THROTTLED` and stream/body-part errors as retryable IMAP errors.
3. Add pure body hydration state transitions.
4. Add Drive store helper to patch body fields on a stored message.
5. Ensure partial success for batch hydration.

### Phase 3: Eager body hydration budgets

Files:

- `src/sync/sync.ts`
- `src/sync/watcher.ts`
- `src/sync/backoff.ts`
- `src/config/schema.ts`
- `tests/unit/sync.test.ts`
- `tests/unit/watcher.test.ts`

Steps:

1. Add hydration policy config with safe defaults.
2. After metadata sync, select eligible recent messages for body hydration.
3. Enforce per-tick message and byte budgets.
4. Skip Gmail All Mail for eager hydration in v1.
5. Record hydration counters/errors separately in watcher report/status.

### Phase 4: Batch body tools

Files:

- `src/tools/loadEmailBodies.ts` (new)
- `src/tools/getFullEmail.ts` (new or adapted from `getEmail.ts`)
- `src/tools/searchEmails.ts` (new, if store search/list API supports required filters)
- `src/tools/registry.ts`
- `tests/unit/loadEmailBodies.test.ts` (new)
- `tests/unit/getFullEmail.test.ts` (new)

Steps:

1. Add batch input schemas with server-side caps.
2. Return cached bodies when available.
3. Hydrate missing bodies with partial-success result.
4. Register tools with descriptions that instruct agents to batch hydrate candidate sets.

### Phase 5: Explicit attachment hydration tools

Files:

- `src/tools/loadEmailAttachment.ts` (new)
- `src/tools/readEmailAttachment.ts` (new)
- `src/store/driveStore.ts`
- `src/imap/fetch.ts`
- `tests/unit/loadEmailAttachment.test.ts` (new)
- `tests/unit/readEmailAttachment.test.ts` (new)

Steps:

1. Resolve attachment by public `attachmentId` from stored payload.
2. Fetch exactly one IMAP part by stored `partId`.
3. Upload to Drive only on explicit call.
4. Patch attachment storage state.
5. Refuse large/binary inline MCP responses.

### Phase 6: Recent-first sync state

Files:

- `src/store/payloadTypes.ts`
- `src/sync/sync.ts`
- `tests/unit/sync.test.ts`

Steps:

1. Add compatibility parser for old and new sync state.
2. Implement initial recent UID window.
3. Add forward and backfill cursors.
4. Add bounded historical backfill per tick.
5. Keep UIDVALIDITY rollover semantics: folder delete + fresh recent-first sync.

Testing approach
----------------

All verification must be automated. No manual-only acceptance steps are part of this design.

Unit tests:

- `tests/unit/fetch.test.ts`
  - `fetchMetadataUidRange()` does not call body part fetch helpers.
  - Body fetch helpers classify Gmail `THROTTLED` as retryable.
  - Attachment download helper propagates stream errors as typed errors, not unhandled exceptions.

- `tests/unit/mapper.test.ts`
  - Metadata-only mapping produces `bodyState=not_loaded` and null bodies.
  - Attachments receive deterministic `attachmentId` and `storageState=not_loaded`.
  - Legacy payload normalization maps missing state fields correctly.

- `tests/unit/sync.test.ts`
  - Main sync upserts metadata and advances checkpoint without body fetch.
  - Main sync never calls `downloadPart()` or `uploadAttachment()`.
  - Metadata checkpoint advances when body hydration fails retryably.
  - Metadata checkpoint does not advance when metadata upsert fails.
  - UIDVALIDITY rollover still deletes/recreates folder and restarts sync.
  - Recent-first initial sync indexes latest UID window first.
  - Backfill cursor advances only after backfill metadata upsert succeeds.

- `tests/unit/bodyHydration.test.ts`
  - Batch hydration returns partial success.
  - Already-loaded bodies are returned from cache without IMAP fetch.
  - Retryable IMAP errors set `failed_retryable` and preserve metadata.
  - Permanent MIME errors set `failed_permanent`.
  - Byte/message budgets stop hydration deterministically.

- `tests/unit/watcher.test.ts`
  - Per-account in-flight lock still prevents concurrent ticks.
  - Watcher status reports metadata sync separately from body hydration.
  - Cooldown skips retryable body hydration until expiry.

- `tests/unit/loadEmailBodies.test.ts`
  - Tool enforces max messages per call.
  - Tool returns partial-success JSON shape.
  - Tool persists hydrated body when `persist=true`.
  - Tool does not load attachments.

- `tests/unit/loadEmailAttachment.test.ts`
  - Tool resolves by `attachmentId`, not `driveInode`.
  - Tool fetches exactly the matching `partId`.
  - Tool patches only the selected attachment state.
  - Retryable upload/fetch failure does not modify body state or metadata checkpoint.

Integration-style unit tests with mocked Drive/IMAP:

- Initial account with 10,000 UIDs indexes only configured recent window on first tick.
- New incoming mail after recent-first init is indexed before historical backfill.
- Agent scenario test:
  1. store has 100 candidate messages, 60 loaded and 40 not loaded;
  2. `search_emails` returns candidate refs and body states;
  3. `load_email_bodies` hydrates missing bodies in capped batches;
  4. failed retryable messages are returned separately without failing the whole tool.

Acceptance criteria
-------------------

- Given a folder with new messages that include attachments, when watcher sync runs, then it writes message metadata and advances the metadata checkpoint without calling attachment download or Drive attachment upload.
- Given an attachment larger than APIS upload limits, when watcher sync runs, then no upload is attempted and mailbox indexing still succeeds.
- Given Gmail returns `THROTTLED` during body hydration, when hydration runs, then the process does not crash, the message body state becomes `failed_retryable`, and metadata checkpoint remains advanced.
- Given Gmail returns `THROTTLED` during metadata fetch, when watcher sync runs, then the folder report contains a retryable error and no checkpoint is advanced past unwritten metadata.
- Given a message has `bodyState=not_loaded`, when `load_email_bodies` is called for it, then the server fetches display body parts, persists body fields when requested, and returns the loaded body in the result.
- Given a batch body hydration request includes loaded and unloaded messages, when the tool runs, then loaded messages are served from cache and unloaded messages are fetched within server caps.
- Given a batch body hydration request has one throttled message, when the tool runs, then the response includes partial successes and `failedRetryable` entry for the throttled message.
- Given an agent searches for messages from a sender, when candidate messages have mixed body states, then the search result includes body state and stable message refs suitable for batch hydration.
- Given a message has attachment metadata, when `load_email_attachment` is called with its `attachmentId`, then the server downloads exactly that IMAP part, uploads it to Drive, and patches only that attachment state.
- Given a caller tries to access attachment content by `driveInode`, when using public MCP/API contracts, then the contract rejects or ignores that identifier and requires `attachmentId`.
- Given an empty large folder with `uidNext=10001`, when recent-first sync runs with `initialRecentWindow=1000`, then the first indexed range is `9001..10000`, not `1..10000`.
- Given a folder has both new forward mail and pending historical backfill, when watcher tick runs, then forward mail is indexed before backfill.
- Given legacy payloads without `bodyState` or attachment `storageState`, when read/normalized by new code, then they are interpreted without data migration according to compatibility rules.

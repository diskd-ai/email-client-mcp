Email Client MCP Attachment Stream Sync Design Doc
=================================================

Context and motivation
----------------------

`email-client-mcp` currently synchronizes IMAP messages into Drive `messagesStore` with body text/html and attachment metadata, but it does not persist attachment bytes. Mailbox can show that an attachment exists, but cannot download it from `messagesStore`. Older legacy flows moved attachment bytes through MCP JSON/app-service and hit APIS timeouts and high memory pressure.

A second recently fixed issue showed that flag reconciliation can overwrite message body fields if it writes envelope-only payloads over already stored messages. Attachment support must not reintroduce this class of data loss.

Read-only contract verification confirmed that the backend storage contract already exists in Drive `messagesStore`; this design therefore does not require new Drive or app-service attachment upload endpoints for v1. The remaining work is to integrate the existing `messagesStore` attachment lifecycle in `email-client-mcp` and to patch storage references back into the opaque message payload consumed by app-service.

Goals:
- Treat attachments as part of successful message sync: a message UID is checkpointed only after its body and all attachment bytes are stored.
- Stream attachment bytes from IMAP to Drive/messagesStore without buffering whole files in MCP pod memory.
- Keep processing sequential for v1 to make checkpoint and retry behavior simple and correct.
- Keep reconciliation in the same watcher flow, but ensure it only updates flags/labels and never downloads or overwrites bodies/attachments.
- Preserve idempotency across retries using stable message `externalId` and stable attachment IDs.

Non-goals for first implementation (v1):
- No parallel message or attachment processing.
- No separate attachment worker or queue.
- No partial-success attachment state exposed to UI.
- No app-service involvement in attachment byte transfer.
- No manual repair of already-corrupted historical messages whose body was previously overwritten to `null`.
- No timeout tuning unless the streaming path still produces a concrete timeout failure.

Implementation considerations
-----------------------------

Key constraints:
- One MCP runtime can serve multiple accounts, so RAM and network pressure must be bounded.
- IMAP attachment parts can be large; attachment bytes must not be loaded into a `Buffer` before upload.
- Checkpoint correctness is more important than maximum throughput for v1.
- Drive `messagesStore` attachment API already exposes the upload lifecycle: `uploadStart`, HTTP `PUT` to upload URL, then `uploadCommit`.
- The Drive upload endpoint requires `Content-Length` and `X-Upload-Intent-Id`; it streams the request body onward instead of expecting bytes in JSON-RPC.
- `Content-Length` must match the IMAP download stream length. Use `imapflow.download(...).meta.expectedSize` for upload intent size and PUT `Content-Length`, because BODYSTRUCTURE attachment size can describe encoded part size and may not match decoded stream bytes.
- Drive stores attachment metadata in a per-mailbox SQLite `attachments` table (`attachment_id`, filename, content type, size, `drive_inode`) and stores bytes as Drive files under a lazily-created per-message folder.
- `messagesStore` does not mutate the opaque message payload when an attachment row is committed; `email-client-mcp` must patch payload attachment refs explicitly before message upsert.
- `imapflow.download(uid, partId, { uid: true })` returns a decoded stream for a bodystructure part and handles transfer encoding/charset for text parts.

Design principles:
- Process UIDs in ascending order.
- A UID is successful only after the complete message payload and all attachment bytes are durable.
- Keep the latest successful UID in memory during a batch; write folder checkpoint once at batch end or once on error.
- Use stable identifiers so retry is safe:
  - message externalId: `${uidValidity}:${uid}`;
  - attachmentId: deterministic value from `${uidValidity}:${uid}:${partId}`.
- Reconciliation updates only mutable IMAP state (`flags`, `labels`, `fetchedAt`) and preserves existing content fields.

High-level behavior
-------------------

For every watcher tick:

1. The watcher lists configured accounts and folders.
2. For each folder, it reads the folder checkpoint (`lastSyncedUid`).
3. It asks IMAP for messages with UID greater than the checkpoint.
4. It processes fetched messages sequentially in UID order.
5. For each message:
   - fetches envelope, flags, body structure, text/html body parts;
   - maps body and attachment metadata into a message payload;
   - upserts the initial message payload into `messagesStore` so Drive can resolve the message row for attachment ownership;
   - uploads each attachment stream from IMAP to Drive/messagesStore;
   - patches the message payload with attachment storage references;
   - upserts the final message payload into `messagesStore`.
6. After the final payload upsert succeeds, an in-memory `successfulUid` moves to that UID.
7. At the end of the batch, the folder checkpoint is written once with `lastSyncedUid = successfulUid`.
8. If one message fails, the folder checkpoint is written once with the last successful UID before the failure, `lastSyncError` is recorded, and the tick stops for that folder.
9. The next tick retries from `lastSyncedUid + 1`.
10. After successful new-message sync, reconciliation checks recent UIDs for flag changes and updates only flags/labels.

Attachment streaming model
--------------------------

Attachment byte transfer is a stream pipeline:

```text
IMAP BODY.PEEK[partId] decoded stream
→ HTTP PUT request body
→ Drive/messagesStore upload intent
```

The MCP server does not return attachment bytes through JSON-RPC and does not pass bytes through app-service. The server only stores attachment references in the message payload.

The message row must exist before attachment upload starts: Drive stores a per-message `attachment_folder_inode` on the message row and attachment rows reference the internal message primary key. Therefore the sync flow first upserts the message payload with body + attachment metadata, but it does not advance the checkpoint until all attachment uploads and the final payload patch are durable.

The upload lifecycle per attachment:

1. Ensure the message row exists via the initial message upsert.
2. Call IMAP `download(uid, partId, { uid: true })` to get a readable stream and `meta.expectedSize`.
3. Call messagesStore attachment `uploadStart` with stable `attachmentId`, filename, content type, and upload size from `meta.expectedSize`.
4. Stream that readable directly into the returned upload URL using HTTP `PUT` with:
   - `X-Upload-Intent-Id: <intentId>`;
   - `Content-Length: <meta.expectedSize>`;
   - `Content-Type: <contentType>`.
5. Read the upload response `etag`.
6. Call messagesStore attachment `uploadCommit` with `attachmentId`, `intentId`, and `etag`.
7. Patch the attachment entry in the message payload with `attachmentId`, `driveInode`, `storedSizeBytes`, and `storedAt`.
8. Final-upsert the patched message payload.

The Drive-side contract treats duplicate `attachment_id` on the same message as `CONFLICT`. Retry logic should make this idempotent in `email-client-mcp`: list/get the existing stored attachment, accept it only when metadata matches the intended upload, and otherwise fail the UID rather than silently overwriting bytes.

Memory model
------------

Current implementation buffers up to one batch of message payloads in memory before `upsertBatch`; attachment bytes are not currently fetched. In the new v1 flow, attachment bytes must not be buffered. Only the current message payload plus one active attachment stream should be resident.

Expected memory characteristics for v1:
- Body text/html remains bounded by the existing mapper body cap.
- Attachment bytes are streamed in chunks and are not held as whole-file buffers.
- Batch size remains useful for IMAP range selection, but message completion is sequential.
- No more than one attachment upload is active at a time in v1.

Checkpoint model
----------------

Checkpoint is the persisted “bookmark” for a folder. It answers: “up to which UID has this folder been fully synchronized?”

Stored in folder metadata:
- `uidValidity`;
- `uidNext`;
- `lastSyncedUid`;
- `lastSyncStartedAt`;
- `lastSyncFinishedAt`;
- `lastSyncError`.

For v1, checkpoint writes are batched for efficiency but remain message-correct:
- Keep `successfulUid` in memory while processing messages sequentially.
- On each successful message, set `successfulUid = uid`.
- On batch success, write `lastSyncedUid = successfulUid` once.
- On message failure, write `lastSyncedUid = successfulUid` once and record `lastSyncError`.

This avoids writing metadata after every message while preventing a failed message from forcing a whole 50-message batch to repeat.

Reconciliation model
--------------------

`flagWindow` is the count of recent UIDs whose IMAP flags are rechecked each tick. It catches changes like read/unread/starred that happen outside this MCP server.

Reconciliation behavior:
- Runs after new-message sync.
- Fetches envelope/flags only.
- Reads existing message payload from `messagesStore`.
- Merges only:
  - `flags`;
  - `labels`;
  - `fetchedAt`.
- Preserves:
  - `bodyText`;
  - `bodyHtml`;
  - `snippet`;
  - `attachments`;
  - attachment references.
- Does not upload attachments.
- Does not move checkpoint.

Error handling and UX
---------------------

Attachment upload failure is a sync failure for that UID:
- The message is not considered successfully synced.
- The folder checkpoint remains at the previous successful UID.
- `lastSyncError` records the attachment failure.
- The next watcher tick retries the failed UID.

Expected error categories:
- IMAP download failure for `partId`;
- upload intent creation failure;
- upload stream PUT failure;
- upload commit failure;
- duplicate attachment conflict with mismatched metadata;
- message payload upsert failure;
- checkpoint write failure.

User-facing behavior:
- A message row can appear in `messagesStore` after the initial upsert because Drive requires that row before attachment upload can start.
- The folder checkpoint advances only after the final payload with attachment refs is durable.
- No “pending attachment” UI state is introduced in v1.
- If an attachment repeatedly fails, the message may remain visible with metadata-only attachments and without storage refs, while diagnostics are visible via `get_watcher_status`.

Update cadence / Lifecycle
--------------------------

The watcher remains the single lifecycle owner:
- no new process;
- no new queue;
- no split full-sync/reconcile worker;
- no app-service attachment transfer path.

Each tick processes accounts/folders according to the existing watcher interval. Per-account in-flight locking remains required so the same account does not run overlapping sync ticks.

Future-proofing
---------------

This design intentionally keeps v1 sequential but structures the work so bounded concurrency can be added later.

Future parallelism can be introduced at these levels:
- attachment-level concurrency within a single message;
- message-level concurrency within a folder;
- account-level global limiter across accounts.

If message-level parallelism is added, checkpoint must advance only to the highest contiguous successful UID after the previous checkpoint. It must never advance to the max successful UID if there is a failed UID gap.

Future enhancements:
- configurable attachment size limits;
- bounded upload concurrency;
- resumable upload support if Drive supports it;
- attachment repair command for historical messages;
- download URL propagation to app-service/UI;
- metrics for attachment upload duration, bytes, failures, and retries.

Implementation outline
----------------------

Phase 1: attachment storage types and IDs
- Extend `StoredAttachment` with optional persisted fields: `attachmentId`, `driveInode`, `storedSizeBytes`, `storedAt`.
- Add pure helper for deterministic attachment IDs.
- Add pure helper to patch attachment storage references back into a message payload.

Phase 2: IMAP part download dependency
- Add `SyncDeps.imap.downloadPart(accountId, mailbox, uid, partId)` returning decoded stream metadata and readable content.
- Implement it using `imapflow.download(String(uid), partId, { uid: true })` under the existing mailbox lock boundary.
- Ensure attachment download uses real MIME part IDs from bodyStructure.

Phase 3: Drive/messagesStore attachment upload dependency
- Add `SyncDeps.drive.uploadAttachment(mailboxId, folderId, externalId, attachment, contentStream)`.
- Implement upload lifecycle using the existing typed SDK scope: `mailbox({ mailboxId }).folder({ folderId }).message({ externalId }).attachments`.
- Call `uploadStart`, stream HTTP `PUT` to the returned `uploadUrl`, then call `uploadCommit` with the returned `etag`.
- Send `X-Upload-Intent-Id`, `Content-Length`, and `Content-Type` on the streaming `PUT`.
- Use streaming HTTP PUT, not Buffer upload and not JSON-RPC byte transfer.
- Treat duplicate/already-existing attachment IDs as success only when the stored metadata matches; mismatches are sync failures for that UID.

Phase 4: per-message successful sync
- Refactor new UID sync so each message is completed sequentially:
  - build payload;
  - initial-upsert payload to create/refresh the Drive message row;
  - upload attachments;
  - patch payload refs;
  - final-upsert complete message;
  - update local `successfulUid` only after the final upsert.
- Flush checkpoint once per successful batch or once on failure.
- Keep batch range fetching for IMAP efficiency, but do not depend on batch-level success for checkpoint correctness.

Phase 5: reconciliation safety
- Keep current merge-only reconciliation behavior.
- Add regression tests that reconciliation preserves attachment refs as well as body/snippet.

Testing approach
----------------

Automated tests only; no manual acceptance steps.

Unit tests:
- `tests/unit/sync.test.ts`
  - Case: one message with one attachment succeeds.
    - Assert `uploadAttachment` is called with mailbox id, folder id, message externalId, part id, filename, content type, and size.
    - Assert message payload is upserted with attachment `attachmentId` and `driveInode`.
    - Assert checkpoint advances to the message UID.
  - Case: attachment upload fails.
    - Assert the initial message row may exist because Drive requires it before `uploadStart`.
    - Assert checkpoint remains at previous successful UID.
    - Assert the failed payload has no attachment storage refs.
    - Assert `lastSyncError` is written.
    - Assert the failing UID is retried on next `runSyncOnce`.
  - Case: message 95 succeeds and message 96 attachment fails.
    - Assert checkpoint advances to 95, not to batch end.
  - Case: reconciliation runs after attachment sync.
    - Assert body/snippet/attachments/attachment refs are preserved while flags change.

- `tests/unit/imap/fetch.test.ts` or new `tests/unit/imap/downloadPart.test.ts`
  - Case: downloads an attachment by concrete part id.
    - Assert it calls IMAP download with UID mode and exact part id.
  - Case: missing part/download failure maps to typed IMAP error.

- `tests/unit/store/driveStore.test.ts` or new `tests/unit/store/attachmentUpload.test.ts`
  - Case: uploadStart + streaming PUT + uploadCommit success.
    - Assert `X-Upload-Intent-Id`, `Content-Length`, and `Content-Type` are sent.
    - Assert no full Buffer conversion is used by the adapter test double.
  - Case: upload PUT fails.
    - Assert typed DriveError is returned.
  - Case: uploadCommit duplicate/already-exists response.
    - Assert idempotent success when metadata matches.
    - Assert mismatched existing metadata is a sync failure.

Integration-style unit tests with fakes:
- `tests/unit/sync.test.ts`
  - Fake IMAP stream emits chunks.
  - Fake Drive upload consumes chunks.
  - Assert peak fake buffered chunk count is bounded to prove no full attachment buffering in sync core.

Acceptance criteria
-------------------

- Given a new IMAP message with one attachment, when watcher syncs the folder, then the message checkpoint advances only after the attachment is stored in messagesStore and the final payload includes storage refs.
- Given that attachment upload succeeds, when app-service reads the message detail, then the opaque message payload attachment entry includes stable storage references (`attachmentId`, `driveInode`, `storedSizeBytes`, `storedAt`) populated by `email-client-mcp` after Drive `uploadCommit`.
- Given attachment upload fails for UID N, when sync finishes, then folder metadata has `lastSyncedUid < N` and `lastSyncError` is non-null.
- Given the next tick runs after that failure, then UID N is retried.
- Given UID 95 succeeds and UID 96 fails, then checkpoint is 95 even if the IMAP fetch batch included later UIDs.
- Given reconciliation runs after a fully synced message, then flags/labels may change but body, snippet, attachments, and attachment storage refs remain unchanged.
- Given a large attachment, sync streams it to Drive/messagesStore without storing the full file in a message payload or JSON-RPC response.
- Given multiple accounts exist in one MCP runtime, per-account locking still prevents overlapping ticks for the same account.

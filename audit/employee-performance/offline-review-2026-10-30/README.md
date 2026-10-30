# Offline review — 2026-10-30

Scope: courier preparation, local projection/outbox, foreground replay, collection payment, server validation and administrator conflict handling. Review only: no application or production database changes in this review.

The durable queue is necessary for disconnected work. The smaller repair is to align payment permission and date validation between the existing preparation/replay paths, rather than replace the storage/sync system.

## Verified findings

1. **P1: prepared collection payments are refused for a permitted courier.** The migrated `get_daily_shop_collection_queue_v2` response contains `queue`, `status`, and `collection_run_id`, without `can_record_payment`. `src/lib/collectionQueue.ts:31` converts this omission to `false`; `src/offline/runtime/project.ts:147` then refuses collection payments. The active courier fixture has collection permission and an open run. `FinancialOperations.tsx:726` selects the prepared snapshot even online. Existing snapshot fixtures omit `canRecordPayment`, hiding the adapter mismatch. Return an explicit permission flag for couriers, or preserve absence and use the existing profile/run checks; do not turn an explicit denial into permission.

2. **P1: queued collection payments cannot pass replay validation after the service day changes.** `employee_offline_assert_expected_v2` calls the live current-day collection queue with the command's original day (runtime migration line 153). The queue rejects previous-day reads by a courier. The actual migrated validator reproduces this date error; wrapper tracing shows that it becomes a conflict. An admin retry does not alter the original day, so it encounters the same guard. Pending prior-day work also blocks new local commands (`store.ts:140`). Add a replay-specific validator using the original collection run and explicit business-date/close policy, keeping ordinary UI date restrictions. This probe validates the failure boundary; it is not an overnight phone E2E.

3. **P2: non-transient RPC failures are endlessly retried with no administrator review path.** `engine.ts:112-118` assigns `retry_wait` to every non-auth exception, including SQL `42501`, and merely changes the backoff. Two sync attempts with that error leave statuses `[retry_wait, pending]`. The administrator view loads only server `conflict` rows (`OfflineConflictReview.tsx:13-15`), which do not exist when the whole request rolls back. Add a distinct actionable infrastructure/contract failure state and manual retry after repair; preserve the original command and avoid relabeling infrastructure errors as business conflicts.

## Evidence

Temporary Vitest probes plus existing client, runtime and write-coordination suites: **42 tests passed**. The two review probes deliberately assert the existing faulty behavior, not repaired behavior. Their source is retained in `reproduction.test.tsx.txt`; copy to `tests/scrutinize-offline-review.test.tsx` to run, then remove the temporary file.

The SQL probe runs all migrations in PGlite with the real courier fixture. Copy `sql-probe.mjs.txt` to `tmp/scrutinize-offline-probe.mjs` and run with Node. Output:

```text
COURIER_QUEUE {"keys":["queue","status","collection_run_id"],"runId":true,"canRecordPayment":false}
YESTERDAY_QUEUE The collection queue is available only for the current Bangkok business date
REPLAY_VALIDATOR_YESTERDAY The collection queue is available only for the current Bangkok business date
NON_COLLECTOR_QUEUE_OK
```

No load-capacity guarantee or iPhone offline-reload acceptance is established by these tests. The earlier PostgreSQL 16 trigger permission fix is already present and is not reported again as an unresolved finding.

Verdict: **fix-then-ship**, principally because the real preparation adapter prevents permitted courier collection payments.

## Fix and validation

All three findings above are repaired in the working tree:

- The collection queue now returns an explicit payment permission. The client preserves an absent legacy flag as `undefined`, while retaining explicit denials and the closed-day guard.
- Historical collection replay uses a private, transaction-scoped capability tied to the authenticated owner's original offline command and collection run. The original run must remain open; closed stock days and reconciliation days remain prohibited. Ordinary courier requests still cannot create historical payments. The context is removed on success or conflict, and rolls back on transaction failure.
- Permanent transport/contract failures become `blocked`. Automatic syncing stops at that command, new writes are refused, and the UI explains that the saved records remain on the device. An explicit retry after repair reuses the same command identity. Network failures retain automatic backoff.

Validation: 88 focused UI/runtime tests; 21 SQL integration tests including an overnight payment, idempotent replay, private permission denial and a closed-run conflict; four concurrent PostgreSQL 16 scenarios; production build; `git diff --check`. All passed. The private-schema version was rechecked with the overnight/runtime integration suites and PostgreSQL 16 concurrency harness.

Migration `20261030052555_offline_collection_replay_and_permissions` was applied to the linked production database and recorded in migration history in one transaction. A production queue read under the `authenticated` role with an active courier returned `status: open` and `can_record_payment: true`; the probe transaction was rolled back. Post-migration security advisors reported no error-level issues.

Production metadata verification confirmed four patched readers and five patched writers, the explicit permission field, private-table RLS, zero retained replay contexts, and rejection outside an offline command. Both `anon` and `authenticated` have no private-schema usage, table insert or helper execution privilege. The first metadata CLI request stalled and was terminated; the bounded read-only retry succeeded.

The frontend changes are built locally, not published. No phone queue was cleared or recreated, and this validation does not establish that the user's 12 saved commands have all reached the server. Billing/event wrappers share the replay capability, but the new overnight end-to-end SQL case specifically covers shop collection payment.

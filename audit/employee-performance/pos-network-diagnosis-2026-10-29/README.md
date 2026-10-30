# POS loading / offline diagnosis — 2026-10-29

Inspected checkout: `7f55daf`. User evidence: IMG_4402.PNG (raw `TypeError: Load failed`, no prices/stock) and IMG_4409.PNG (loading prices/stock/payment terms). This investigation changes no application behavior and deploys nothing. The installed iPhone build and the actual failing network requests have not been captured, so findings about the checkout must not be treated as proof of the deployed build or a specific production outage.

## Confirmed causes in the checkout

### 1. POS cache/fallback was removed before full offline transactions were implemented

Commit `8f5c802bfd06aa7b4929b203654362f8bf4b1170`, dated 2026-10-22, removed the five-minute POS memory/localStorage cache and the stale-data fallback from `createSupabaseGateway`. Previously, non-forced reads could return recent cached context, and failed reads could return stale context. This does not establish that the old version safely supported offline writes.

Current `src/EmployeeDeliveryWorkspace.tsx:497` explicitly requires a new server read on each subsequent shop visit. Single-flight only shares an unfinished request; it does not cache successful results. Invalidation also deletes legacy persisted POS snapshots (`:301`). This is a concrete code-level explanation for increased dependence on network availability in this version.

The intent is to avoid using stale shared stock. Reinstating old stock as authoritative would not implement correct offline selling.

### 2. Existing offline functionality is partial

- `vite.config.ts`: app shell, static assets, catalog photos and fonts are cached; no Supabase business-data RPC cache.
- `src/lib/employeeWorkspaceCache.ts`: persisted rounds, ice types and shop cards, scoped to user/date, with a 24-hour age limit. These are not the complete POS context.
- `src/features/employee-delivery/useEmployeeDeliveryData.ts:548`: up to 50 in-memory previews retain prices/payment labels, remove usable stock and are marked stale. The preview map is lost when the workspace unmounts or user/date/round changes. Shops never successfully opened have no preview.
- `src/offline/` contains contracts and fingerprints. There is no IndexedDB/outbox/sync engine connected to the employee UI. Delivery/payment gateways still call RPC directly.
- `docs/employee-full-offline-plan.md:3` records progress only through Step 2A (ledger schema/shared helpers). Later work explicitly includes IndexedDB, local-first reads, durable outbox and UI integration.
- `src/PwaUpdatePrompt.tsx:57` sets offline-ready from service-worker readiness; `:157` says the app is ready offline. This does not check that the day's prices, stock, payment rules or transaction queue are ready.

This explains how a shop name and images can remain visible while its prices and stock are unavailable. “ยังไม่มีราคา” in this loading/error state is not evidence that the administrator failed to configure a price.

### 3. Global resume refresh bypasses the POS five-minute cooldown

`src/RoleRouter.tsx:192` initializes global realtime sync with default options. `src/lib/realtimeSync.ts:50` uses a 15-second focus/visibility cooldown, followed by a 250 ms debounce, and publishes all change scopes on resume (`:122`).

The POS workspace separately sets a five-minute foreground cooldown (`src/EmployeeDeliveryWorkspace.tsx:214, :931`). However, its stock/POS change subscriber (`:914`) receives the global event, invalidates POS reads, reloads cards/holdings and refreshes the open POS context without checking that five-minute cooldown.

Controlled component test: initial opening = 1 POS load; first focus = 2; another focus after 16 seconds = 3. Disable only global `enableFocusCatchup`, and the same experiment stays at 1. This is event-triggered, not a periodic poll every 15 seconds. The initial expectation of two simultaneous refresh paths was disproved: the workspace cooldown starts at mount, so it correctly suppresses its own immediate focus refresh. The global path still bypasses it.

Realtime stock/POS changes can also invalidate an open read and refresh it. The realtime publisher already debounces changes; actual production event frequency has not been measured.

### 4. Long waits and all-or-nothing loading

`src/EmployeeDeliveryWorkspace.tsx:211` sets a 60-second deadline per started POS request. `:504` makes a forced refresh wait for an existing request before starting its own deadline. In a deterministic stalled-request experiment, the first request times out at 60 seconds; the forced refresh then starts and times out at 120 seconds total. This is a conditional worst-case reproduction, not a measurement of the user's screenshots.

When the server advertises split-context support, `:524` runs stock and sale requests in parallel but accepts neither until both complete and match. One failed part rejects the whole load and aborts its sibling. Thus even a successful price response does not populate a cold shop while stock fails or hangs. The UI changes to a slow-network message after ten seconds, but continues waiting.

### 5. Transport errors reach the UI without useful recovery/context

The POS path performs one read attempt; it has no automatic bounded retry for transient transport failures. The installed PostgREST client uses POST for these RPCs and does not automatically retry network errors for POST (`node_modules/@supabase/postgrest-js/src/PostgrestClient.ts` and `PostgrestBuilder.ts`).

`employeeErrorMessage` leaves an unrecognized error message unchanged. Injecting the SDK-shaped error `{message: 'TypeError: Load failed'}` through the real POS gateway reproduces the screenshot's loading message, empty prices, raw error and manual retry button. It does not identify what originally broke transport on the phone.

Fetch can reject with TypeError on network/request failures; a normal HTTP error alone does not make fetch reject. See [MDN fetch documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch). The screenshots do not distinguish Wi-Fi route/DNS/TLS/CORS, resume-related browser behavior, or an upstream connection failure. They also do not prove a database business-rule error.

## Experiment ledger

| Experiment | Result | Interpretation |
| --- | --- | --- |
| Existing `employee-live-shop-refresh.test.tsx` | 74/74 passed | Existing tests intentionally enforce new reads and rejecting stale stock; passing tests do not establish offline capability. |
| Cold shop, pending RPC then SDK-shaped Load failed | Reproduced screenshot text, no price, retry button; 1 RPC | UI/gateway failure path confirmed without real server writes. |
| Global focus with initial expectation of 3 calls | Failed: actual count was 2; repeated once with compact diagnostics | Disproved immediate duplicate local+global refresh at mount; local five-minute cooldown is initially effective. |
| Corrected focus test, then second focus at +16 seconds | 1 → 2 → 3 calls | Global refresh bypass confirmed. |
| Same focus test with global catchup disabled | Remained at 1 | Differential control isolates the global path. |
| Existing stalled request plus forced refresh | Refresh pending at 60 s, rejected at 120 s | Deadline excludes waiting for predecessor. Fake timers; no two-minute real wait. |
| Final temporary diagnostics | 4/4 passed | Cold-load UI, focus enabled/disabled, chained timeout. |
| Supabase connector project listing | Tool unavailable (`Unknown tool`) | Production logs/migrations/latency not verified. |
| Supabase changelog fetch | Web tool rejected markdown content type | No Supabase implementation/API changes made. |

The temporary test additions were removed from the active suite. Their exact final source is retained in `reproduction-fragment.tsx.txt`; it uses the fixtures/mocks in `tests/employee-live-shop-refresh.test.tsx`. To reproduce, temporarily append the fragment to that file and run:

```sh
DEBUG_PRINT_LIMIT=500 npx vitest run tests/employee-live-shop-refresh.test.tsx -t 'diagnosis:' --maxWorkers=1 --no-file-parallelism --reporter=dot
```

Remove only the appended fragment afterward. No debug instrumentation was added to application code.

## Recommended repair order

1. Unify resume/realtime invalidation so one event does not bypass the intended freshness policy. Preserve refresh after writes and relevant cross-device stock changes; add a test joining the real global publisher with the workspace.
2. Bound the entire POS read lifecycle, including time spent awaiting an older read. Add a bounded retry only for verified read operations/transient transport failures, with cancellation and late-response protection. Keep transaction retries governed by idempotency.
3. Persist scoped product/price/payment previews separately from stock authority; display the last verified snapshot and its freshness while refreshing. Distinguish “price unavailable because load failed” from “price not configured.” This improves browsing but alone does not enable offline sales.
4. Complete the planned business-data bundle, IndexedDB atomic outbox, sync/conflict handling and offline transaction UI. Do not label business data ready until those readiness checks pass. Keep inventory/payment validation and conflict handling intact.
5. Measure the actual installed iPhone build: request name, elapsed time, status/error, abort reason, resume trigger and a correlation ID, excluding credentials/customer payloads. Pair a failing request with server logs to determine the remaining transport or server cause.

No production latency improvement, outage root cause, or completed offline fix is claimed by this diagnosis.

## Review fixes — online writes and offline preparation

The four failing review reproductions in `scrutinize-repro.test.tsx.txt` were promoted into `tests/employee-offline-write-coordination.test.tsx` and fixed locally:

- Cold stock/delivery/immediate-sale writes and the collection payment button now use the same durable online-write guard as corrections and other online-only operations.
- Preparation captures both command sequence and a separate IndexedDB revision. Online write start/completion, explicit invalidation and approved discard advance that revision. An older preparation cannot restore balances fetched before one of those changes, including when no prior snapshot exists.
- The guard has no time-based expiry. A UI timeout, lost reply or transient HTTP response keeps it in IndexedDB; only the identical request can replay. Holder checks prevent an older attempt from releasing a newer attempt's guard. Pending online writes also block sign-out and PWA updates.
- Credit deliveries carrying an approval use the guarded live writer, retaining server approval validation; offline credit-limit validation remains strict.

Online requests also retain the original replay payload and account. `OnlineWriteRecovery` offers an explicit recovery button after reload, using an allowlist of original gateway methods/RPCs. Successful recovery removes the matching pending-form identity and reloads current data. This covers operations whose forms generate a new request ID on remount, such as delivery cancellation and event tank handoff. A different account cannot replay the saved request.

Validation for this repair: 164 tests passed across 12 affected suites, including the four original reproductions, the actual collection-payment button, account isolation, durable recovery after reopening IndexedDB and preventing stale preparation. `npm run build` passed; Vite still reports its existing large-chunk warning. This is a focused regression run, not a claim that every repository test passes. No SQL change was needed for these four fixes, and no migration or frontend deployment was performed.

A final WebKit run also reproduced an evidence failure after another reload: the saved Blob could no longer be read (`The object can not be found here.`), leaving collection in `retry_wait`. New commands now persist bounded evidence bytes/MIME type in the same transaction as the command and balances, then create a fresh upload Blob from those bytes. Earlier Blob rows remain readable when their backing file is available. An evidence-read failure commits neither the command nor stock changes; confirmed commands release local evidence bytes while retaining the uploaded path. Both Chromium and WebKit business-data scenarios passed on two fresh-profile runs after this change; see `review-fixes-browser.log` and `review-fixes-browser-repeat.log`.

The browser harness exercises real Chromium/WebKit IndexedDB and the runtime with deterministic test transports. Its online-write scenario checks persistence after reopening, rejection of another operation, replay of the original request and rejection of the old preparation revision. It does not replace a full application/iPhone acceptance test. WebKit's offline shell reload remains an explicit blocked gate because service-worker control or CacheStorage entries disappear on reload in this Playwright setup; no iPhone offline-boot pass is claimed. The harness's `--require-webkit-shell` flag keeps that acceptance gate fatal when required.

## Airplane-mode follow-up — 2026-10-30

Evidence: IMG_4438.PNG shows an open shop with prices/stock still loading and the old global message requiring internet before every save. The user could not recall whether the day's preparation had completed. The installed build and device IndexedDB have not been inspected.

At checkout `86116ac`, the offline gateway correctly reads a valid prepared snapshot and commits delivery plus stock changes to IndexedDB without a network request. New regression coverage exercises that gateway with `navigator.onLine = false` and verifies the durable command and reduced stock. However, absent or expired preparation fell through to the live POS reader even while offline. Both cases reproduced in failing tests. The global PWA warning also still claimed that all saves required internet, irrespective of the runtime's readiness.

The repair rejects the unavailable offline POS read immediately with a preparation instruction and changes the global message to describe prepared local saves and later synchronization. It does not manufacture prices, extend expired stock validity, or make unprepared shops writable. Preparation remains automatic, scoped to the courier and Bangkok service day; the day's data must finish downloading before disconnection.

A credential-free probe of the deployed `get_employee_offline_capability` RPC returned `401 / 42501: permission denied for function get_employee_offline_capability`, confirming the function exists and anonymous access is denied. This does not verify the employee's enrollment, preparation outcome, other deployed wrappers, or phone version. The Supabase connector was unavailable (`Unknown tool`). No production data was changed and no deployment was performed.

Validation: 44 tests passed across the client, runtime, write-coordination, PWA message, and cache-cleanup suites. The missed coverage was the offline gateway's unprepared/expired fallback, rather than the already-tested prepared outbox. Full iPhone acceptance and the particular device's preparation failure remain unverified.

## Confirmed sync failure — 2026-10-30

The 11:54 screenshot showed 12 unconfirmed commands; the first withdrawal failed with `permission denied for table employee_offline_commands`. Live inspection confirmed that the typed RPCs and their v2 helpers are owned by `postgres` and use SECURITY DEFINER, while the two deferred invariant trigger functions used SECURITY INVOKER.

Changing the real PostgreSQL 16 harness to call the withdrawal RPC as `authenticated` reproduced the exact error at COMMIT in `employee_offline_assert_command_issue_state_v1`. The previous harness used a superuser connection with a courier JWT claim, so it checked application authorization but missed database-role permissions. PGlite did not reproduce this failure even with `SET LOCAL ROLE authenticated`; PostgreSQL changed deferred-trigger security context in newer versions (see [upstream change](https://www.postgresql.org/message-id/E1tb0y4-0037sb-1e%40gemulon.postgresql.org)). Real PostgreSQL 16 coverage is necessary for this regression.

Migration `20261030050054_offline_deferred_trigger_permissions.sql` makes the two trigger-only invariant checks SECURITY DEFINER with a fixed search path, retaining the client EXECUTE revocations and private table access. Their purpose is to validate the ledger's final state, including cross-row decisions, not expose data or accept new caller payloads. Existing typed RPC authorization remains responsible for admitting writes. No stock, payment, command payload, or retry identity is rewritten.

After the migration, the PostgreSQL 16 harness passes the original authenticated concurrent-withdrawal reproduction, competing deliveries, competing collections, and configuration races. The 20 runtime/ledger checks pass as well. The repair preserves idempotency so devices can retry their original queued commands. User-visible queue clearance must be verified separately; changes in stock or payment rules since preparation can still require administrator review.

Applied to the linked production project after the user unlocked access. Readback confirms both checks use SECURITY DEFINER and the fixed search path, with authenticated EXECUTE and direct ledger INSERT still denied. Security advisors reported no error-level findings before and after. The two screenshot command IDs queried after the repair were not yet present in the server ledger, so no claim is made that the phone's queue has cleared. The standard migration-history repair could not establish its direct Postgres connection; history is recorded through the same Management API SQL path used for the fix.

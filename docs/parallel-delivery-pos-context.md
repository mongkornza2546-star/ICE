# Parallel delivery POS reads

Migration `0257_parallel_delivery_pos_context.sql` adds `get_delivery_pos_context_part(uuid,text)` and `get_event_delivery_pos_context_part(uuid,text)`. Each accepts `stock` or `sale`.

- `stock` reads inventory quantities and the source. It skips payment-profile/credit-exposure queries and gates effective-price lookups off.
- `sale` reads effective prices and payment terms, including credit and VAT. It does not call either stock-balance function.

Both requests start concurrently when a shop opens. The gateway joins them by ice-type ID and verifies the stop, round, date and product sets before accepting the complete result. A partial response cannot enable submission. After ten seconds, the UI shows a slow-network notice while continuing to wait for the current request. A sixty-second hard deadline aborts both HTTP requests and releases single-flight for retry. A failed part also aborts its sibling. Responses after that deadline are discarded. The existing delivery writer remains authoritative for stock, prices, VAT and payment rules.

Stock is always read from the server. Completed POS contexts are neither cached nor restored from browser storage; concurrent reads for the same shop may share a request, but each subsequent visit starts a fresh read. If either part fails, the whole read fails and retry is shown. Existing context can retain the draft and price labels, but its stock quantities are hidden and new delivery submissions are blocked until the refresh succeeds. Legacy stale contexts are also blocked. Idempotent replays of an unresolved delivery remain allowed, because the original write may already have reduced stock.

Existing local `stock`/`pos` notifications and Supabase Realtime notifications refresh the open shop. A notification deferred during submission or while the workspace is hidden refreshes both the shop and employee holdings on resume. Holding-stock reads do not join an older in-flight read that may predate a withdrawal. Successful withdrawals apply the returned server state; successful deliveries refresh holdings before returning to the shop list. The transactional writer still checks actual stock under its database locks.

Stock invalidation also removes and aborts all pending POS reads, including other shops drawing from the same holding. The next visit starts immediately without joining a pre-write request. Late responses from aborted reads are rejected, and their cleanup cannot remove a newer request for the same shop.

Migration `0258_employee_stock_realtime_visibility.sql` adds a SELECT policy for active couriers to the already-published `stock_movements` table. They can observe movements on dates when they belong to a delivery round, affecting either the configured active courier-source truck or their own active holding. Shared-truck changes from another round on the same date are included because the stock ledger is date-based. Unrelated holdings/trucks and unassigned dates remain excluded; movement items and write permissions are not opened. Existing manager visibility remains unchanged.

Support is advertised as `pos_context_parts_version: 1` in the existing `get_employee_active_session` response, so no additional capability request is needed. Without that flag, the frontend uses the legacy RPC. Install migration 0257 before enabling the deployed frontend; installing the migration with the old frontend is also compatible. No production deployment was performed as part of this change.

Install migration 0258 as well for courier cross-device stock notifications. Local tests exercise the database SELECT policies and the frontend notification handlers; they do not establish a live Supabase WebSocket connection.

The migration derives the part readers from the installed full readers to retain all regular/event access checks, frozen event policies, admin truck routing, courier holding rules and closed-day rules. Future changes to either full reader must also update the part readers; reapplying this migration regenerates them and checks the expected source fragments.

Validation covers concurrent request start, fresh reads on revisiting a shop, rejection of saved stock on network failure, missing/mismatched parts, a failed request beside a stalled request, timeout/retry and late responses. Database tests compare combined parts with the full context, including event deliveries after closure, check permissions, and replace stock functions with failing probes to prove the sale request does not invoke them. These establish the parallel structure and removed work; they do not claim a measured production latency improvement.

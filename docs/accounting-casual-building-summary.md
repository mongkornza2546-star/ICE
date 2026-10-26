# Accounting casual summary by building

Apply `supabase/migrations/0256_accounting_casual_summary_building.sql` after
`0249_casual_sales_by_building.sql`, then deploy the frontend from this change.
The migration can be reapplied. It replaces only the summary reader and does not
update transactions or closed-day snapshots.

The summary card previously read global casual totals even when the shop report
selected a building. The daily matrix already supported building attribution,
but the summary RPC and its label had retained the original global contract.

The summary now uses `p_filters.building_id` against `sale_building_id` for sales,
receipts, refunds and free-transaction counts. Refunds use the original sale's
building. Sales/free counts retain service-date and active-status rules; receipts
and refunds retain their own Bangkok recording-date windows, including receipts
for subsequently voided sales. Shop, zone, search and payment-status filters do
not constrain casual totals.

Selecting all buildings includes historical sales with no building. Selecting a
specific building excludes those records rather than guessing their location.
The UI names the selected building and explains this scope. Existing shop totals,
manager permissions and date limits remain in the underlying summary reader.

Validation: the database regression first reproduced a selected-building result
of 175 instead of 60. It now covers two buildings, unattributed history, empty
buildings, voids, old-sale refunds, Bangkok day boundaries, reapplication and
courier denial. The UI regression switches A → B → empty C → all buildings and
checks displayed totals and scope text.

## Combined receipt card

Apply `supabase/migrations/20261026102717_accounting_combined_receipts.sql`
before deploying the updated frontend. The card is now “ยอดรับชำระรวมในช่วง”:
shop receipts plus casual receipts for the selected building, grouped into cash
and transfer/QR. Its expandable details retain the separate shop/casual amounts.
It uses receipt dates, not casual sales totals or the paginated daily matrix.

Actual shop refund settlements and casual refund confirmations in the date range
are displayed separately, with net receipts equal to gross receipts minus both.
Pending refunds do not reduce net receipts. Shop refunds follow the same current
shop/search/building/zone scope as shop receipts, including inactive shops; casual
receipts/refunds follow the selling building only. Billing-status and payment-term
filters do not constrain these cashflow totals. All date boundaries use Bangkok.
Historical casual sales without a building appear only when all buildings are selected.

Existing RPC fields remain shop-only or casual-only, so other consumers cannot
accidentally count the casual receipts twice. New fields are
`casual_cash_received_amount`, `casual_transfer_received_amount`, and
`shop_refunded_in_period`. Missing fields display “—” rather than inventing zero
amounts during deployment. No transaction or closed-day snapshot is changed.

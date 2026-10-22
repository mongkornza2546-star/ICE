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

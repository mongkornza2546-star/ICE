# Executive financial report

## Data audit

The accounting and executive RPCs store sales, payment allocations, settled refunds,
current receivables, quantities and damage. There is no monetary inventory valuation,
cost-of-goods ledger, operating-expense ledger, complete cash-disbursement ledger,
or opening cash/bank balances in the existing schema. Those measures, profit,
profit rankings and profit trends must remain unavailable, with reasons, not zero.
Current mutable charge/payment projections are not historical balance snapshots;
do not infer comparative receivables from the selected period's sales or receipts.

## Reporting basis

- Net sales: effective active charge amount minus the bill's stored VAT, plus active
  paid casual sales. Includes regular and event tank rental charges. Migration
  0223 aligns VAT arithmetic; 0245 aligns accounting's charge and shop scope.
  With the same dates and no shop filters, executive `sales` equals accounting
  `totals.sales_amount + totals.casual_sales_amount` (casual sales remain separate
  in the accounting UI). Deactivating a shop does not erase its sales history.
- Active adjustments (including stored discounts/returns) affect the sale on its
  service date. Cancelled charges/deliveries are excluded. Settled refunds are not
  deducted from sales a second time.
- Collections: existing allocated payment amounts on Bangkok recorded dates.
  Cancelled casual sales retain their cash history until a refund is confirmed.
- Refunds: settled/confirmed amounts on their actual Bangkok settlement dates.
- Collections less refunds are explicitly *not* total business net cash flow.
- Receivables: maximum of zero and effective gross charge less active allocations.
  They are current balances at the report's `asOf`, independent of date filters.
- Aging uses due date, falling back to service date as in the existing system.
  Due today is not overdue. Buckets: not due, 1–7, 8–30, over 30 days.
- Comparison is the immediately preceding equal-length inclusive period. Zero
  baselines show absolute changes without a fabricated percentage. Missing history
  stays unavailable. Increasing cost/debt is adverse; increasing sales is favorable.

## Scope and navigation

The top date filter applies to whole-business period sales and collections.
The four tabs are Overview, Sales, Collections and Receivables, and Volume.
Overview shows sales and net collections with changes against the preceding
equal-length period, then a separate current receivables section with its own
snapshot date. Trends, evidence-based follow-ups and a compact area chart follow.
Zero comparison baselines show an absolute difference without a percentage.
The repeated five-card block no longer appears in every tab.

Sales retains single-period trends, shop and area breakdowns, quiet-shop signals
and two-period comparison. Collections and Receivables contains the receipts
equation, payment channels, current aging and overdue-shop follow-up list.
Aged drilldowns preserve the selected bucket through shop, invoice, pagination
and back navigation; due-today invoices belong to the not-due bucket.

The Volume tab contains daily quantities and the monthly table, delivery count,
per-product quantities/damage and area breakdowns. The table explicitly uses its
own selected month, separate from the top period filter, and retains selection
when switching tabs, changing the main range or refreshing across midnight.
Until a month/day is explicitly selected, it follows the main range's end date.
Daily exports using the main report are disabled during refresh or after a refresh
error; independently loaded monthly snapshots retain their own error state.
Missing daily metadata remains unavailable, never zero.
All currency values retain up to two decimal places. Profit is deferred until
cost and expense data exists.

## Deployment and validation

Apply `0252_executive_volume_sale_building.sql` after 0249 to include measured
paid casual sales in their explicitly recorded selling building's volume.
Unassigned sales and loose-sale conversions stay in the casual group; overall
product and daily totals are unchanged. This replaces only the volume read model
and does not rewrite transactions or infer buildings from stock sources.

Apply `0244_executive_sales_and_aging.sql` after the existing report migrations
before releasing the UI. It patches the shared sales fact projection to the
same VAT basis as accounting migration 0223, so summaries, daily/monthly trends,
areas, rankings and sales detail rows remain consistent. It adds
`salesBasis: 'excluding_vat'`, `agingDetailsVersion: 1`, invoice sales/VAT
breakdown and the admin-only `get_executive_report_aging_details` endpoint.
Existing report signatures remain compatible, and internal helpers remain private.

Then apply `0245_accounting_executive_sales_parity.sql`. Accounting summary,
daily matrix and invoice details include active rental charges on their invoice
service dates. Tank quantities still use physical handoff dates. Inactive shops
and closed event booths remain visible when they have active invoices in the
period, current outstanding debt or active collections in the period. Empty
inactive shops are not added to the operating registry. Invoice items use the
existing charge-line reader, so rental descriptions, payments and source bills
remain inspectable. These are read-model changes; they do not reactivate shops
or rewrite historical financial records.

Existing installations without 0244 show a visible legacy VAT-basis notice.
Aging amounts stay plain text until the new version metadata enables bucket
drilldowns; the existing general debt drilldown remains available. If the VAT
basis differs across two fetched comparison snapshots, totals and export are
withheld until refresh.

Integration tests reconcile summary trends, areas and aging with detail rows.
Cross-report tests run the actual accounting summary, daily and invoice RPCs
alongside the executive RPC on the same fixture. They cover VAT, adjustments,
cancelled charges/deliveries, casual sales, both rental types, inactive shops,
closed events, pagination, historical collections and idempotent migration runs.
Do not reconcile a top-ten customer ranking as if it included all customers.
Excel loads all relevant detail pages and compares sums before saving.
A discrepancy blocks export and prompts a refresh. Demo fixtures are labeled as
simulated; they are never substituted for production RPC failures. Demo exports
use a `demo-` filename prefix and start every sheet with a simulated-data notice
and an explanation that supporting rows are incomplete examples whose totals may
differ from the summary.

Validation commands:

```
node --test tests/executive-reports.integration.test.mjs
npx vitest run tests/executive-reports.test.tsx tests/executive-follow-ups.test.tsx tests/report-daily-quantities.test.tsx tests/report-comparison.test.tsx --maxWorkers=1 --no-file-parallelism
npm run build
```

## Sales comparison UI

The Sales tab offers a single-period view and a two-period comparison. Period A
uses the existing date filter; B can be the immediately preceding inclusive
period of equal length, shifted back a week/month/year, or manually selected.
The week shortcut uses Monday through today versus the same weekdays last week.
Month/year shifts clamp to the last valid day (including leap years). Each range
retains the report endpoint's 366-day limit and excludes future dates.

Both snapshots come from the existing `get_executive_report` RPC. Apply migration
`0228_executive_daily_comparison.sql` after 0227 for daily sales and ice series.
It adds `dailyTrend` without changing the existing monthly-bucketed `trend`.
Sales retain that endpoint's accounting basis. Volume is
its delivered quantity projection, including adjustments and casual sales, not
the count of delivery records. Tables join by area kind/ID and ice type ID/unit,
include identities present in only one period, and never sum different units.
Missing `volumeAreas` metadata remains unavailable rather than zero. Zero
percentage bases show absolute differences and an unavailable percentage.
Unequal periods also show averages per calendar day. Today is marked incomplete.

Summary cards, daily line charts, grouped comparison bars by area/type,
three breakdown tables and the comparison Excel export share the same snapshots.
The daily chart aligns day 1 of A with day 1 of B and labels both actual dates;
ice selection keeps each type/unit separate. Missing daily metadata or dates
outside the shorter period appear as gaps, while confirmed zero days show zero.
An expandable daily table exposes every date and value. Legacy sales trend data
is usable only for ranges of at most 31 days; monthly buckets are never presented
as daily values. Daily volume requires migration 0228.
Sales amounts open the existing detail drawer using the clicked period's dates.
The export records both date ranges, day counts and snapshot timestamps on every
sheet, including the two daily sheets. It exports summary comparisons, not invoice-level reconciliation. Demo
comparison data is labeled and exported with a `demo-` prefix. Comparison failures
hide totals and disable export; stale responses after date changes are ignored.

Comparison selection lives in the report page so custom B dates survive switching
report tabs or single-period mode. Relative shortcuts retain their preset identity
and recalculate on refresh, focus and visible-page polling across Bangkok midnight;
manual ranges remain fixed. This corrects the earlier component-local B state and
the week shortcut incorrectly being stored as a custom range. Daily projections
are tested against summary totals, including adjustments, cancelled entries,
casual sales, leap years and the 366-day limit. Demo daily allocations reconcile
to their explicitly simulated totals and are never used for production failures.

Validation: `npx vitest run tests/report-comparison.test.tsx tests/executive-reports.test.tsx tests/executive-follow-ups.test.tsx --maxWorkers=1 --no-file-parallelism`.

## Quantity date range and forecast

The Quantity tab shares the overview presets and inclusive from/to dates. Its
daily chart, table and exports follow that range. Forecasts default to seven days
after the range end, with one-day and thirty-day options. Training uses the last
28 completed days up to that end, excluding the unfinished Bangkok current day.
Each ice type/unit is calculated separately: use the same weekday's mean when
at least two matching days exist, otherwise the daily mean. Fewer than seven
observed days yields an unavailable forecast rather than zero.

The forecast loads active types from `ice_types`, including `created_at`, even
when the parent report already covers the training window. Report product totals
omit types without sales, so they cannot supply the forecast catalog. Calendar
rows generated by the daily RPC also predate newly created types: an empty
product array becomes a zero only on or after that type's Bangkok creation date.
An explicit historical record in the training window can establish earlier
availability for imported sales. Missing calendar rows stay unknown. Catalog or
history failures block the forecast and expose a retry action.

These rules fix two review regressions: six days of a new product's sales were
diluted across 28 calendar days, and changing only the range start could remove
zero-sale types. The regression suite covers both, creation across Bangkok
midnight, imported sales, inactive types and catalog failure/retry. Both original
reproductions also passed using output from the production SQL in local PGlite.
No database migration is required for this correction.

Validation: `npx vitest run tests/quantity-forecast.test.tsx tests/report-volume-date.test.tsx tests/report-daily-quantities.test.tsx tests/executive-reports.test.tsx tests/report-comparison.test.tsx --maxWorkers=1 --no-file-parallelism`.

### Event-aware forecast and simpler presentation (2026-10-28)

Apply `20261028140523_quantity_forecast_event_context.sql` before deploying the
new forecast UI. The read-only, active-admin RPC `get_quantity_forecast_context`
returns the active catalog, 28 complete ordinary-demand days and published jobs
intersecting the next 30 days (including preparation dates). It reuses the
existing private volume-area projection once per training day and excludes
`kind = event`; corrections, legacy event-building attribution and loose-stock
rounding retain the report's rules. Ordinary sales on event days remain included.
The client does not fall back to mixed history when this RPC is unavailable.

The default view shows one quantity card per type/unit for seven days. A date
strip switches the cards to a single day; changing horizon resets to the period
total. Scheduled events for the selected period appear separately. There is no
ice pre-order quantity field in this context, so event quantities are explicitly
unavailable and are never added as zero or presented as a combined preparation
total. No-event messaging refers to published jobs in the current schedule;
it is not a guarantee that no future demand exists. Historical anchors use the
current event schedule, not a point-in-time schedule snapshot, and must not be
used as a backtest. Forecast accuracy has not yet been measured.

Daily tables and method details are collapsed by default. Demo figures and jobs
are labeled as simulated. Validation covers card/day/horizon interactions,
insufficient history, failure/retry, stale responses, event exclusion (including
legacy destinations and adjustments), upcoming-job filtering and RPC permissions.
The SQL integration suite uses actual production helpers in local PGlite; no
production database or deployment was changed during this work.

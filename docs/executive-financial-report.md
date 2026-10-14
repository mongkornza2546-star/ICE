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
  paid casual sales. Includes tank rental charges. Matches accounting migration 0223.
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

The top filter selects the entire business or a shop. Scoped summaries, trends,
aging, rankings, drilldowns and exports all carry the same shop and dates.
Quantities/damage and quiet-shop signals are suppressed in shop scope because the
existing whole-business projections cannot safely be reused there. Aged drilldowns
preserve the selected bucket through customer, invoice, and back navigation.

Overview shows eight metrics and at most five evidence-based follow-ups. Analysis
contains the profit equation, cash limits, aging and receipt channels. Raw records
remain in the existing paginated detail drawer. Quantity charts are expandable.
All amounts use baht with up to two decimal places; missing measures have no amount.

## Deployment and validation

Apply `0226_executive_financial_reporting.sql` after 0225 before releasing the UI.
It patches the existing sales fact projection, adds previous gross collections,
shop choices and invoice VAT breakdown, and introduces scoped/aging read-only RPCs.
Active-admin checks protect both new endpoints; the balance helper is private.
Existing installations without 0226 retain a visible legacy VAT-basis notice and
cannot offer a shop filter until the new metadata exists. Aging amounts remain
readable as plain text until `financialVersion: 1` enables bucket drilldowns;
the existing general debt drilldown remains available.

Summary validation checks complete trend, area, receipt-method and aging totals.
Do not reconcile a top-ten customer ranking as if it included all customers.
Excel additionally loads all relevant detail pages and compares sums before saving.
A discrepancy blocks export and prompts a refresh. Demo fixtures are labeled as
simulated; they are never substituted for production RPC failures. Demo exports
use a `demo-` filename prefix and start every sheet with a simulated-data notice
and an explanation that supporting rows are incomplete examples whose totals may
differ from the summary.

Validation commands:

```
node --test tests/executive-reports.integration.test.mjs
npx vitest run tests/executive-reports.test.tsx tests/executive-financial.test.tsx tests/executive-follow-ups.test.tsx --maxWorkers=1 --no-file-parallelism
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

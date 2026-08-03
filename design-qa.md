## 2026-08-03 — Shop purchase history

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-03เวลา 15.58.49.png` (2880 × 1800 px), showing the existing production shop-detail modal and its visual system.
- Rendered implementation: [outputs/shop-purchase-history-desktop.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/shop-purchase-history-desktop.png) (1280 × 720 px), captured from the actual local demo shop modal with the purchase-history tab active.
- Responsive implementation: [outputs/shop-purchase-history-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/shop-purchase-history-mobile.png) (390 × 844 px).
- Combined comparison evidence: [outputs/shop-purchase-history-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/shop-purchase-history-comparison.png) (1280 × 1467 px).
- Viewport and normalization: desktop rendered at 1280 × 720 CSS px; the in-app browser reported device pixel ratio 2 and returned a CSS-normalized 1280 × 720 capture. The reference modal was cropped from the 2880 × 1800 source to 2665 × 1405 and normalized to 1280 × 675 before stacking with the implementation. Mobile rendered at 390 × 844 CSS px. Browser and operating-system chrome were excluded from layout judgments.
- State: an active shop detail modal with its overview visible, `ประวัติการซื้อ` active, three realistic history entries, all payment states represented, and the 90-day/all-status filters selected.
- Full-view evidence: the comparison board shows the shared modal header, overview grid, thin dividers, tab treatment, blue accent, white surface, and low-elevation border language together. The new history content intentionally replaces the source basic-information form, so content-level fidelity was judged against the existing modal system rather than as identical copy.
- Focused-region evidence: the common header/overview/tab surfaces and the new summary/history cards are readable in the full-resolution combined board. No extra crop was required. Mobile overflow and active-tab visibility were checked through browser measurements.

**Findings**

- No actionable P0/P1/P2 differences remain. The fifth tab, summary strip, filters, dated purchase cards, payment-status pills, and empty/loading/error states use the existing shop-modal typography, spacing, border, radius, icon, and color language.
- The history content has no horizontal overflow at desktop or 390 px mobile. The mobile tab strip intentionally scrolls horizontally, and the selected tab is automatically brought fully into view.
- Older deliveries without financial snapshots remain visible as `ข้อมูลเดิม` instead of disappearing or inventing totals.

**Required Fidelity Surfaces**

- Fonts and typography: retained Noto Sans Thai with the source modal's compact weights, line heights, muted metadata, numeric emphasis, and truncation behavior. History amounts use the existing Thai-baht formatter.
- Spacing and layout rhythm: retained the source modal frame, hero spacing, eight-cell overview, tab underline, thin dividers, and compact control sizing. New cards use 10–11 px radii and the same low-shadow/border rhythm. Mobile collapses summaries and card metadata to two columns without overflow.
- Colors and visual tokens: retained navy text, muted blue-gray labels, primary blue icons/active state, white surfaces, and pale blue containers. Green, amber, and red are used only for paid, partial, and outstanding semantic states.
- Image quality and asset fidelity: the supplied ice logo and sidebar water artwork remain unchanged. Standard UI icons use the existing Phosphor library; no emoji, handcrafted SVG, CSS artwork, or placeholder illustration was introduced.
- Copy and content: labels cover date, item quantities, payment term, payment method, total, and outstanding amount. The page explicitly states the 100-entry cap, and legacy unpriced rows use honest fallback copy.

**Interaction And Build Checks**

- In-app browser: opened a shop, selected `ประวัติการซื้อ`, verified three entries and four summary metrics, then filtered to `ยังมียอดค้าง`; the paid charge disappeared and the partial/unpaid charges remained (2 cards).
- Responsive browser check: 390 × 844 CSS px; page, modal, and history content all reported no horizontal overflow. The active history tab was fully visible after selection.
- Browser console: no errors or warnings.
- Database contract: `node --test tests/shop-purchase-history-contract.test.mjs` passed, 2/2. It verifies active allocations, partial/outstanding totals, legacy deliveries, and exclusion of cancelled/voided records.
- Focused shop UI suite: `npx vitest run tests/shop-settings-card-catalog.test.tsx tests/shop-purchase-history.test.tsx` passed, 14/14, including the existing read-only shop behavior.
- Production build: `npm run build` passed. The existing Vite large-chunk warning remains unchanged.
- `git diff --check`: passed.

**Comparison History**

- Initial mobile pass found a P2 header-action wrap: `ปิดร้าน / ย้ายออก` was compressed into a narrow vertical label. The mobile hero now moves its action group to a full-width row, and the button measures about 98 × 40 CSS px with normal copy flow.
- Initial breakpoint transition could leave the active fifth tab outside the visible portion of the horizontal tab strip. The modal now scrolls the selected tab into view; post-fix browser evidence reported `fullyVisible: true` with no content overflow.

**Follow-up Polish**

- P3: Add server-side date/status parameters if a later requirement expands this view beyond the current latest-100 operational history.

final result: passed

---

## 2026-08-03 — Daily aggregate count desktop density

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-03เวลา 15.55.35.png` (2880 × 1800 px), showing the production count cards before this density repair.
- Rendered implementation: [outputs/daily-aggregate-count-layout-desktop.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/daily-aggregate-count-layout-desktop.png), captured from the actual `DailyAggregateStockClose` component with representative data.
- Responsive implementation: [outputs/daily-aggregate-count-layout-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/daily-aggregate-count-layout-mobile.png).
- Side-by-side evidence: [outputs/daily-aggregate-count-layout-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/daily-aggregate-count-layout-comparison.png).
- Viewports: desktop 1600 × 900 CSS px and mobile 390 × 844 CSS px, both at device scale factor 1. The source was normalized from 2880 × 1800 to 1600 × 1000 for the comparison board; Safari and macOS chrome were excluded from app-layout judgments.
- State: aggregate stock open with six ice types, all counts matching zero, optional note empty, and close action enabled.
- Full-view evidence: the comparison board shows the six desktop cards reduced from two stacked content rows to one compact row per item, bringing the full grid, note, and close action into one viewport.
- Focused-region evidence: the desktop card identity and count control are visibly aligned on one baseline. At 390 px the card returns to a stacked layout; browser measurement confirmed `clientWidth = scrollWidth = 390`, so no focused overflow crop was needed.

**Findings**

- No actionable P0/P1/P2 issues remain. Desktop cards use their available horizontal space instead of reserving a second row for the count field, while the mobile layout retains readable 140px controls and natural vertical flow.
- The responsive grid now chooses one or two columns from a 460px minimum card width, preventing cramped two-column cards at intermediate widths.

**Required Fidelity Surfaces**

- Fonts and typography: the existing Noto Sans Thai stack, hierarchy, weights, sizes, truncation, and line heights are unchanged and remain readable at both checked viewports.
- Spacing and layout rhythm: desktop identity and input controls share one row with a 16px gap; the 64px image slot, 14px padding, 10px radius, 12px grid gap, and mobile stacked spacing remain aligned with the existing design system.
- Colors and visual tokens: existing navy text, muted blue-gray metadata, pale card background, border, primary blue, and neutral status styling are unchanged.
- Image quality and asset fidelity: production continues to use its signed ice-type images and existing Phosphor placeholder icon. The local visual fixture intentionally shows the component's real no-image state; no asset implementation was replaced.
- Copy and content: all production labels, item summaries, units, note copy, and close action are unchanged.

**Interaction And Build Checks**

- Browser: all six cards rendered; the first count accepted `2.5`, switched the note to required, and preserved the existing interaction flow.
- Browser console: no errors or warnings.
- Mobile overflow: `clientWidth = scrollWidth = 390`.
- Regression contract: `node --test tests/daily-aggregate-stock-mobile-layout.test.mjs` passed, 2/2.
- Focused stock-control UI suites passed, 20/20.
- Production build: `npm run build` passed. The existing Vite large-chunk warning remains unchanged.

**Comparison History**

- Initial supplied state: P2 density issue; each wide card stacked the count control below a 64px identity row, making six zero-state items require excessive vertical scrolling.
- Fix: changed each desktop card to an identity/input grid row and changed the outer grid to responsive auto-fit columns with a 460px minimum.
- Post-fix evidence: all six desktop items, the note, and the close action fit in the 1600 × 900 viewport; mobile remains overflow-free and readable.

**Follow-up Polish**

- None required for this layout repair.

final result: passed

---

## 2026-07-31 — Employee collection payment popup

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/IMG_2991.PNG` (944 × 2048 px) for the employee collection screen, plus the payment-popup wireframe in the 2026-07-31 request.
- Intended implementation: `src/FinancialOperations.tsx`, opened by selecting a shop from the courier collection queue.
- Implementation screenshot path: unavailable. The Codex in-app browser could not reach the local preview process, and its loopback URL resolved to a different app. Chrome control was unavailable.
- Intended viewport: 393 × 852 CSS px at device scale factor 1.
- Source dimensions and normalization: the supplied screenshot is 944 × 2048 px; it provides page context rather than a pixel-exact popup image. The prompt wireframe defines the popup content hierarchy. No implementation density normalization was possible without a rendered capture.
- State: courier popup open for `ร้านครัวน้องปาย (เบอร์ 9)`, ฿100 due, cash selected, and ฿500 received.

**Findings**

- [P1] Browser-rendered mobile comparison is unavailable.
  Location: employee collection payment popup.
  Evidence: the source screenshot and prompt wireframe are available, but the local implementation could not be captured in the connected browser.
  Impact: responsive fit, typography, spacing, sticky actions, and visual parity cannot be marked as visually passed from source code or component tests alone.
  Fix: open the authenticated employee collection screen or a reachable local preview at 393 × 852, capture cash and transfer states, then run the side-by-side comparison.

**Required Fidelity Surfaces**

- Fonts and typography: implementation retains the existing Thai application font stack and compact mobile hierarchy; browser verification is pending.
- Spacing and layout rhythm: the popup is a mobile bottom sheet with equal-width configured payment choices, a compact received/change row, and sticky actions; browser verification is pending.
- Colors and visual tokens: existing navy, blue, pale-blue, green, and white payment tokens are reused; browser verification is pending.
- Image quality and asset fidelity: existing signed shop images and Phosphor UI icons are retained. No emoji, handcrafted SVG, or placeholder image was added.
- Copy and content: the popup includes shop identity, amount due, every payment method configured for the shop, live change, slip evidence, note, cancel, and immediate-save actions. The wireframe's defer/credit choice was removed because the current API has no durable collection-disposition action and credit is a shop-level term rather than a collector choice.

**Interaction And Build Checks**

- Focused UI suite: `tests/financial-operations.test.tsx` passed, 15/15.
- Full UI suite: `npm run test:ui -- --maxWorkers=1 --minWorkers=1` passed, 142/142.
- Covered interactions: opening from a shop card, cash partial payment and oldest-first allocation, distinct bank-transfer and QR selection, clearing hidden transfer evidence when returning to cash, evidence size validation, receipt printing, Escape/focus trapping, and focus restoration.
- Production build: passed. The existing Vite large-chunk warning remains unchanged.
- Aggregate `npm test` remains blocked before UI tests by the unrelated `admin-backdated-billing-contract.test.mjs` assertion against the current `RoleRouter.tsx` date comparison.
- Browser console: unavailable because a browser-rendered implementation could not be reached.

**Comparison History**

- First pass: blocked by missing browser-rendered implementation evidence; no visual correction loop was possible.
- Contract rework: removed the non-persistent defer/credit action, restored distinct configured transfer methods, and reset method-specific reference/evidence state when switching methods.

**Implementation Checklist**

- Capture the cash state at 393 × 852 with ฿500 received and verify ฿400 change.
- Capture bank-transfer and QR states at the same viewport when those methods are configured.
- Fix any P0/P1/P2 visual differences and repeat the comparison.

final result: blocked

---

## 2026-07-28 — Collection shop cards, popup, and bill numbers

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/IMG_2972.PNG` (944 × 2048 px), plus the existing POS shop-card pattern in `src/features/employee-delivery/EmployeeShopPicker.tsx`.
- Rendered implementation: [outputs/collection-popup-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-popup-mobile.png).
- Side-by-side evidence: [outputs/collection-reference-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-reference-comparison.png).
- Viewport: 393 × 852 CSS px at device scale factor 1. The 944 × 2048 source was normalized to 393 × 852 only for the comparison board; the implementation screenshot is natively 393 × 852.
- State: courier collection queue with one shop selected and the receive-payment popup open, showing two outstanding bills.
- Full-view comparison evidence: the existing inline payment form and the revised popup were reviewed together at the same normalized mobile size. The revised screen preserves the original blue/white visual system while separating shop selection from payment entry.
- Focused-region evidence: the popup header, bill list, payment fields, file control, close target, and confirm action are all readable at 393 px, so no additional crop was required.

**Findings**

- No actionable P0/P1/P2 differences remain. The popup fits within the mobile viewport, has no horizontal overflow, and does not require internal scrolling for the representative two-bill state.
- The shop image in the visual fixture is intentionally a local test asset. Production uses the existing signed `shop-images` URL and `object-fit: cover`; a storefront icon appears only when a shop has no saved image.

**Required Fidelity Surfaces**

- Fonts and typography: retained the app's Thai font stack and hierarchy. Shop code, name, outstanding total, bill number, and form labels remain distinct and readable without wrapping collisions.
- Spacing and layout rhythm: the popup uses a 393 px bottom-sheet layout, 14–16 px gutters, 48 px form controls, and a 42 px close target. Browser measurement confirmed `bodyScrollWidth = bodyClientWidth = 393`.
- Colors and visual tokens: retained the existing navy text, primary blue action, pale-blue form surface, white cards, and low-contrast borders from the POS and collection screens.
- Image quality and asset fidelity: production shop photos use the existing storage images; standard UI marks use the existing Phosphor icon package. No handcrafted SVG, emoji, or CSS-drawn icon substitutes were added.
- Copy and content: each pending charge now shows a stable bill number, service date, original bill amount, and remaining balance. The queue card shows the number of outstanding bills and total due.

**Interaction And Build Checks**

- Browser: verified the open popup at 393 × 852; no horizontal overflow and no console errors or warnings.
- UI test: opens the popup from a shop card, renders the signed shop photo and both bill numbers, and records a partial payment oldest-first.
- Database integration: the new migration applies to the full financial schema, generated bill numbers match `BYYMMDD-000001`, and both collection queues expose shop image paths and bill numbers.

## 2026-07-29 — Review corrections

- Supersedes the “bill number” terminology above: the pre-payment identifier is a delivery-charge reference, stored as `charge_number` and displayed as “เลขรายการส่ง” in `CYYMMDD-000001` form. It is not an invoice or receipt number.
- The payment popup now moves focus to its close control, traps Tab navigation, makes the underlying page inert, locks body scrolling, supports Escape, and restores focus to the selected shop card.
- The migration backfill is now exercised against an existing historical charge before a replacement charge is inserted. This test exposed and fixed deferred trigger events that had to be flushed before `ALTER TABLE ... SET NOT NULL`.
- Final verification: 175 database/contract tests passed, 133 UI tests passed, and the production build passed.
- Full suite: 174 database/contract tests and 132 UI tests passed.
- `npm run build`: passed.

**Comparison History**

- Initial comparison: no P0/P1/P2 findings; no visual correction loop was required.

**Follow-up Polish**

- P3: Native file-input wording follows the device/browser locale, so its exact label may differ between iOS Safari and desktop preview.

final result: passed

---

## 2026-08-02 — Actual-count mobile layout repair

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ระบบจัดส่งน้ำแข็งศูนย์ราชการ 2.png` (1320 × 2868 px), showing the broken production mobile layout.
- Rendered implementation: [outputs/daily-aggregate-stock-mobile-fixed.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/daily-aggregate-stock-mobile-fixed.png), captured from the actual `DailyAggregateStockClose` component with representative local data.
- Side-by-side evidence: [outputs/daily-aggregate-stock-mobile-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/daily-aggregate-stock-mobile-comparison.png).
- Viewport: 393 × 852 CSS px at device scale factor 1. The source was displayed at 393 × 852 for comparison; its original 1320 × 2868 density was normalized by display size and top-aligned crop. The implementation is a native 393 × 852 browser capture.
- State: “ตรวจนับจริง” active, daily aggregate open, first item at 32 bags with matching system quantity, and no note entered.
- Full-view evidence: the comparison board shows the broken 20px-wide detail column beside the repaired layout. Browser and PWA chrome differ and were excluded from the layout judgment.
- Focused-region evidence: the first item row measures 327px wide; its detail text receives 185.8px, the input wrapper stays 140px, and only the unit label remains 20px. The body measured `clientWidth = scrollWidth = 393`, confirming no horizontal overflow.

**Findings**

- No actionable P0/P1/P2 issues remain. Product names, system quantities, movement summaries, inputs, and units read in normal horizontal lines instead of a one-word-per-line column.
- The root cause was the broad `.input-row small` selector assigning every nested summary line a 20px width. The repaired selector applies that fixed width only to `.input-wrapper > small` and allows the item description to flex within the row.

**Required Fidelity Surfaces**

- Fonts and typography: the existing Thai font stack, weights, sizes, and hierarchy are unchanged; wrapping is now natural and readable.
- Spacing and layout rhythm: the existing one-column mobile grid and 140px count input are preserved. Detail copy expands into the remaining row space without page overflow.
- Colors and visual tokens: existing navy, muted blue-gray, primary blue, white surfaces, borders, and status badge are unchanged.
- Image quality and asset fidelity: no image or icon assets were added or replaced; the comparison uses the supplied screenshot and the app's existing UI assets.
- Copy and content: production copy is unchanged. Representative preview values mirror the supplied first-row state (`32`, ordered `50`, sold `18`).

**Interaction And Build Checks**

- Browser: changed the first count from `32` to `31`; the close action correctly stayed disabled until a required note was entered, then became enabled.
- Browser console: no errors.
- Regression contract: `node --test tests/daily-aggregate-stock-mobile-layout.test.mjs` passed, 1/1.
- Focused UI suite: `npm run test:ui -- --run tests/manager-stock-control.test.tsx` passed, 18/18.
- Production build: `npm run build` passed. The existing large-chunk warning remains unchanged.

**Comparison History**

- Initial supplied state: P1 responsive failure; all nested `<small>` elements inherited `width: 20px`, producing extreme vertical wrapping.
- Fix: scoped the 20px width to the unit label and made the description span a shrink-safe flex item.
- Post-fix evidence: the 393 × 852 capture has readable summaries, usable inputs, and no horizontal overflow; no further P0/P1/P2 corrections were required.

**Follow-up Polish**

- None required for this repair.

final result: passed

---

## 2026-07-29 — Receive-payment layout refresh

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-29เวลา 18.12.38.png` (provided receive-payment layout reference).
- Intended implementation: `src/FinancialOperations.tsx`, opened from the collection queue with a shop selected.
- Implementation screenshot path: unavailable — the local production route requires an authenticated Supabase session; the available demo route does not expose the financial-operations screen.
- Intended viewport and state: 630 × 742 reference, payment dialog open, cash selected, a received amount entered, and evidence not yet attached.

**Findings**

- [P1] Browser-rendered visual comparison is blocked by the unavailable authenticated collection state. The form was therefore not marked as visually passed from source code or tests alone.

**Required Fidelity Surfaces**

- Fonts and typography: implemented with the existing Noto Sans Thai stack; browser visual verification is pending.
- Spacing and layout rhythm: implemented as a compact single-column payment card with grouped method buttons, amount field, quick values, summary row, and fixed action row; browser visual verification is pending.
- Colors and visual tokens: uses the established blue primary action, pale blue summary surface, green monetary figures, white fields, and existing border tokens; browser visual verification is pending.
- Image quality and asset fidelity: no new raster assets were needed; standard controls use the installed Phosphor icon set.
- Copy and content: payment method, live allocation/change/remaining amounts, reference, evidence, receipt choice, cancel, and confirmation are connected to the existing payment flow.

**Interaction And Build Checks**

- `npm run test:ui -- --run tests/financial-operations.test.tsx`: passed, 13/13.
- `npm run build`: passed.
- Existing record-payment validation, oldest-first allocation, evidence requirements, focus management, automatic receipt printing, dynamic method tabs, and receipt flow remain covered by the focused UI suite.
- Payment evidence is rejected above 5 MB in the dialog, and migration `0114_limit_payment_evidence_to_5mb.sql` applies the same storage limit.

**Implementation Checklist**

- Sign into a collection-enabled account, open one shop's receive-payment dialog, capture it at the reference state, and run the side-by-side visual comparison.

final result: blocked

---

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-23เวลา 12.35.00.png` (legacy damage form) and `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-23เวลา 12.35.53.png` (the requested transfer-card pattern).
- Intended implementation: the damage/melt tab in `src/ManagerStockControl.tsx`.
- Required rendered implementation screenshot: unavailable.
- Intended viewport: desktop, matching the supplied 2048 × 1280 screenshots.
- State to compare: damage tab selected, a source-location card selected, one or more product quantities selected, note entered, and confirmation summary enabled.

**Findings**

- [P1] Browser-rendered visual comparison is unavailable.
  Location: local demo preview.
  Evidence: the Vite demo server starts successfully on port 4173, but the available in-app browser cannot resolve `terminal.local`; its local-host fallback is blocked by browser URL policy.
  Impact: the revised card layout cannot be captured and compared side by side with the supplied screenshots in this environment.
  Fix: open the demo in a browser that can reach the local server, capture the requested damage state, then compare it with the transfer-card screenshot.

**Required Fidelity Surfaces**

- Fonts and typography: not visually verified.
- Spacing and layout rhythm: not visually verified.
- Colors and visual tokens: not visually verified.
- Image quality and asset fidelity: unchanged existing Phosphor icons and supplied application assets; not visually verified.
- Copy and content: code inspection and UI tests confirm the damage flow exposes source selection, item cards, an optional note, summary, and the damage-specific confirmation label.

**Interaction And Build Checks**

- `npm run test:ui -- tests/manager-stock-control.test.tsx`: passed, 18/18.
- `npm run build`: passed.
- The damage submission test confirms a source-only record, no destination, and an optional note.

**Implementation Checklist**

- Capture the revised damage flow at the target desktop viewport.
- Compare it side by side with the transfer-card reference and resolve any P0/P1/P2 visual differences.

final result: blocked

---

## 2026-07-24 — Ice type layout redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 24 ก.ค. 2569 16_48_10.png`.
- Rendered implementation: [outputs/ice-types-layout-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/ice-types-layout-final.png), captured from the local preview route `?screen=ice-types-layout`.
- Side-by-side evidence: [outputs/ice-types-layout-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/ice-types-layout-comparison.png).
- Viewport: implementation 1680 × 940 CSS px at device scale factor 1; the 1672 × 941 source was scaled only for the side-by-side review.
- State: desktop, `ชนิดน้ำแข็ง` tab active, first item selected, six active types, one current price row.

**Findings**

- No actionable P0/P1/P2 differences remain. The comparison matches the reference's 247px sidebar, 282px content start, tab row (~167px), metric cards (~225px), split editor start (~331px), compact image row, and fixed bottom action treatment.
- Product thumbnails in the local preview are intentionally placeholders because the preview does not connect to storage. Production continues to render each saved `image_path` through the existing signed-URL flow; this is sample-data variance rather than a layout replacement.

**Required Fidelity Surfaces**

- Fonts and typography: Noto Sans Thai hierarchy, compact labels, and A/B/C section headings match the reference's dense admin UI.
- Spacing and layout rhythm: sidebar, content gutters, card heights, split columns, and price-entry spacing were aligned to the reference viewport.
- Colors and visual tokens: blue active/navigation states, pale metric icon surfaces, white cards, borders, and semantic green/purple pills are preserved.
- Image quality and asset fidelity: existing logo, sidebar artwork, Phosphor icons, and the production image-rendering path are retained; no custom-drawn image substitutes were introduced.
- Copy and content: labels, filters, status badges, price history, and save actions remain coherent and functional.

**Interaction And Build Checks**

- Browser: switched to `ชนิดน้ำแข็ง`, searched for `น้ำแข็งก้อน`, selected the result, and confirmed the form updated; no console warnings or errors.
- `npm run test:ui`: passed, 14 files / 77 tests.
- `npm run build`: passed.

**Follow-up Polish**

- P3: Production thumbnails will naturally reflect each customer's stored ice imagery rather than the static sample imagery shown in the reference.

final result: passed

---

## 2026-07-27 — Today dashboard reference redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 24 ก.ค. 2569 17_28_58.png` (1491 × 1055 px).
- Rendered implementation: [outputs/today-dashboard-reference-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/today-dashboard-reference-final.png), captured from the local demo route `?screen=today-layout` at 1280 × 1087 CSS px, device scale factor 1.
- Responsive implementation: [outputs/today-dashboard-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/today-dashboard-mobile.png), captured at 390 × 844 CSS px, device scale factor 1.
- State: work session in progress, four populated overview cards, four stock holders, three active staff cards, two action alerts, and four operational shortcuts.
- Full-view comparison evidence: source and implementation were opened together in the visual comparison pass. The source browser chrome was excluded from fidelity judgments; the implementation uses the existing application sidebar and top bar.
- Focused regions reviewed: overview cards, distribution flow, staff panel, stock-holder grid, alert list, and shortcut row. These regions carry the reference's hierarchy and density, so focused review was required.

**Findings**

- No actionable P0/P1/P2 differences remain for the requested desktop layout. The implementation matches the reference's page hierarchy: four summary cards, paired route/team panels, stock and alert panels, and four colored quick actions.
- P3: Production staff cards correctly use the existing user icon because the daily dashboard contract does not currently expose avatar URLs. This avoids introducing fabricated portrait assets; the layout will accommodate avatars if the data contract is extended later.

**Required Fidelity Surfaces**

- Fonts and typography: retained the application's Noto Sans Thai family and compact Thai dashboard scale, with a strong page heading, small supporting labels, and numeric emphasis aligned to the source.
- Spacing and layout rhythm: desktop grid and cards use the reference's compact gutters, rounded white surfaces, low shadows, paired middle rows, and full-width shortcut strip. At 390 px, cards collapse to two columns and panels stack without page overflow.
- Colors and visual tokens: existing blue navigation and stock color, pale blue/green/orange icon surfaces, white cards, green work-status pill, amber alerts, and blue/teal/purple quick actions were mapped to the reference.
- Image quality and asset fidelity: retained the supplied ice logo and sidebar water artwork. Standard UI controls use the existing Phosphor icon set; no handcrafted SVGs, fake portrait images, or CSS artwork were added.
- Copy and content: visible values are tied to the existing daily-dashboard and stock-summary data. The demo route has realistic local data only for visual verification; production still fetches the live RPC data.

**Interaction And Build Checks**

- Browser: verified the rendered desktop and 390 px mobile layouts, opened the overflow menu, and confirmed the cancellation action appears. Browser console: no errors.
- `npm run test:ui`: passed.
- `npm run build`: passed.

**Implementation Checklist**

- Completed: visual hierarchy, responsive layout, data bindings, overflow cancellation menu, alert routing, and operational shortcut routing.

**Follow-up Polish**

- P3: Add employee avatar URLs to `get_daily_work_dashboard` if portrait imagery is required for this screen.

final result: passed

---

## 2026-07-24 — Shop directory layout redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 24 ก.ค. 2569 09_27_31.png`.
- Rendered implementation: [outputs/shop-layout-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/shop-layout-final.png), captured from the local demo route `?screen=shops-layout`.
- Viewport: reference 1672 × 941 px; implementation 1672 × 941 CSS px at device scale factor 1.
- State: desktop card view with eight demo stores, POS readiness metrics, all directory filters visible, and no filter selected.

**Findings**

- [Resolved P1] The first pass wrapped the directory search independently from the filter controls at the source viewport. The toolbar now keeps the search, filters, and view switcher on the same row at desktop width, matching the reference hierarchy.
- [Resolved P2] The initial narrow layout allowed the directory controls to exceed the mobile viewport. The mobile toolbar now stacks the search and uses a two-column filter grid; browser measurement confirmed no horizontal overflow.
- No actionable P0/P1/P2 differences remain for the requested desktop layout. Store summary cards, status colors, compact four-column cards, topbar context controls, sidebar, and directory controls align with the reference's visual structure.

**Required Fidelity Surfaces**

- Fonts and typography: Noto Sans Thai is retained with dense dashboard-scale labels, a clear page title, and compact metadata.
- Spacing and layout rhythm: matched at the 1672 × 941 desktop viewport; the action row, metric row, filter row, and two rows of cards preserve the reference hierarchy.
- Colors and visual tokens: blue primary actions, pale blue/green/orange/red status surfaces, white cards, and low-elevation borders follow the supplied design.
- Image quality and asset fidelity: the supplied logo and sidebar water artwork are retained; standard UI icons use the existing Phosphor icon library. No image substitutions were added.
- Copy and content: status labels are bound to the POS-readiness report in production; the preview uses realistic local sample data solely for the visual route.

**Interaction And Build Checks**

- Browser: searched for `AA12`, verified one matching store, switched to the list view, and confirmed no console errors.
- Responsive browser check: 390 × 844 CSS px; no horizontal page overflow after the mobile toolbar correction.
- `npm run test:ui -- --run tests/shop-settings-card-catalog.test.tsx`: passed, 3/3.
- `node --test tests/shop-card-image-layout.test.mjs`: passed, 1/1.
- `npm run build`: passed.

**Follow-up Polish**

- P3: The demo view intentionally uses eight mock stores; production continues to use the connected store and POS-readiness data.

final result: passed
## 2026-08-03 — Immediate payment screen aligned with end-of-day collection

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-03เวลา 08.26.44.png` (1296 × 1214 px), the supplied end-of-day collection payment screen.
- Intended implementation: the immediate-payment branch in `src/features/employee-delivery/EmployeeDeliveryReview.tsx`, using the existing `financial-ops__*` payment surface tokens in `src/index.css`.
- Implementation screenshot: `/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/immediate-payment-redesign-cash.png` (648 × 600 px).
- Viewport and density: implementation captured at 648 × 600 CSS px, device scale factor 1. The source was downsampled from 1296 × 1214 to 648 × 607 for review. The source is a payment-sheet crop; the implementation capture includes the employee-app shell, so the shell was excluded from content-level fidelity judgment.
- State: immediate payment for demo shop `AA01 กาแฟลุงนิด`, cash selected, `฿100.00` received for a `฿30.00` due amount, with `฿70.00` change. The target uses different fixture values (`฿150.00`), so numeric values were compared for hierarchy and formatting rather than literal equality.

**Findings**

- No actionable P0/P1/P2 visual findings remain. The implementation now follows the supplied collection pattern: shop identity header with close affordance, due amount card, icon-led payment methods, received/change panel, quick amounts, two-column settlement summary, evidence/reference fields, and clear primary action.
- [P3] The target calls its free-text field a note, while the existing immediate-payment contract exposes `เลขอ้างอิง` and payment evidence. The existing labels and payload fields were preserved so current validation and record-payment behavior remain intact; this is an intentional product-contract deviation.
- [P3] The demo profile exposes QR as a third method, while the supplied target shows cash and transfer. The method grid is driven by the shop payment profile, so production-configured methods remain accurate.

**Full-view Comparison Evidence**

- The source and implementation were opened together in the visual comparison pass after normalizing density. Overall hierarchy, section order, card treatment, method selection state, cash/change relationship, summary layout, and action hierarchy are aligned with the target.
- The implementation has no horizontal overflow at the reviewed 648 px viewport (`clientWidth === 648`, `scrollWidth === 648`). The shell/crop difference is contextual and not counted as a design mismatch.

**Focused Region Comparison Evidence**

- The payment-sheet header, due card, payment-method row, received/change panel, quick amount row, and settlement summary were readable in the normalized full-view comparison; no additional crop was needed for a decision. Form labels, icons, and selected/disabled states were also checked through the live DOM and interaction states.

**Required Fidelity Surfaces**

- Fonts and typography: retained the existing Thai application font stack and financial-operations hierarchy; emphasized amount values use tabular numerals and the target's strong navy/blue hierarchy.
- Spacing and layout rhythm: reused the shared payment card, section gaps, rounded borders, action grid, and responsive minmax tracks; added form/fieldset min-width guards for the narrower immediate-payment sheet.
- Colors and visual tokens: reused the existing navy, blue, pale-blue, green change, white surface, border, and selected-state tokens from `financial-ops__*`.
- Image quality and asset fidelity: retained the real shop image when available and uses Phosphor icons (`Storefront`, `Money`, `Bank`, `QrCode`, `UploadSimple`, `X`); no emoji, handcrafted SVG, CSS art, or placeholder image was added.
- Copy and content: changed the immediate-payment title to `บันทึกรับชำระเงิน`, made the amount labels match the target flow, and preserved the existing reference/evidence semantics required by the live payment API.

**Interaction And Build Checks**

- In-app browser flow verified: cash quick amount `100` produces change `฿70.00`; switching to transfer changes the amount label and hides cash change; transfer overpayment shows the validation alert and disables confirmation; exact cash `30` enables confirmation.
- Browser console check: no errors or warnings (`[]`).
- `npm run test:ui -- --maxWorkers=1 --minWorkers=1`: 22 files passed, 142 tests passed.
- `npm run build`: passed. Vite emitted the existing large-chunk warning only.
- `git diff --check`: passed.

**Comparison History**

- First implementation pass replaced the old success-style immediate-payment popup with the shared collection/payment surface and updated the focused POS heading assertions.
- Final pass re-captured the cash state at the normalized viewport, compared it with the supplied target, and found no actionable P0/P1/P2 mismatch.

final result: passed

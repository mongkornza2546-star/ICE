## 2026-08-07 — Employee ice-withdrawal mobile layout

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 7 ส.ค. 2569 17_34_13.png` (852 × 1851 px, @2x mobile capture including device/browser chrome).
- Normalized source content: [outputs/employee-withdrawal-reference-normalized.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/employee-withdrawal-reference-normalized.png) (426 × 848 px), cropped to the app-owned header/content/bottom-navigation region.
- Rendered implementation: [outputs/employee-withdrawal-layout-mobile-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/employee-withdrawal-layout-mobile-final.png) (426 × 848 px), captured from `?screen=employee-withdrawal-layout` in the Codex in-app browser.
- Viewport and normalization: implementation viewport 426 × 848 CSS px at DPR 1. The 852 px-wide @2x source was downsampled to 426 px and device/browser chrome was removed before comparison.
- State: courier `เบิก` tab, one open daily round dated 07 Aug 2026, truck stock 100/50/0 bags, holding stock 0, no quantities selected.
- Full-view comparison evidence: normalized source and final browser capture were opened together at the same 426 × 848 size. Header, horizontal intro/date badge, white task panel, route card, three product cards, paired actions, and fixed three-tab navigation align to the same page regions.
- Focused-region evidence: the full-resolution 426 px comparison keeps Thai labels, card controls, stat cells, icons, and action/navigation rows legible; no additional crop was needed.

**Findings**

- No actionable P0/P1/P2 layout differences remain.
- Accepted data-state difference: the local demo deliberately has no uploaded `image_url`, so product-image slots are blank in the implementation capture. Production now signs each existing `ice_types.image_path` and renders the user's uploaded image with `object-fit: contain`; no generated fallback or placeholder image is used.
- Accepted behavior difference: zero-quantity reset/confirm actions remain disabled to preserve the existing validation contract, while the visual reference presents them at full emphasis.

**Required Fidelity Surfaces**

- Fonts and typography: the existing Thai font stack, navy hierarchy, compact blue eyebrow, product labels, muted metadata, and numeric emphasis closely match the source. Long product names are now protected from the earlier one-column truncation.
- Spacing and layout rhythm: the 16 px mobile page margin, section top at 151 px, 149 px product cards, 8 px card gaps, 48 px action row, and 55 px bottom navigation align with the normalized source. The document and viewport widths are both 426 px.
- Colors and visual tokens: retained the source's white/pale-blue field, navy text, blue outlines and selected state, low-contrast gray stat tiles, green post-transfer value, and restrained shadow/border treatment.
- Image quality and asset fidelity: logo and UI icons use existing assets/the installed Phosphor set. Product art is sourced only from uploaded `image_path` values and displayed as a contained raster image; generated fallback art was removed at the user's direction.
- Copy and content: `เบิกน้ำแข็ง`, task guidance, daily-work date, truck/holding route, before/after stock labels, reset, confirmation, and bottom-tab copy match the requested workflow.
- Accessibility and interaction: quantity controls retain explicit labels, disabled bounds, live numeric output and 46 px mobile tap targets. Reset and confirmation remain semantic buttons; the product rows retain table/group semantics.

**Interaction And Build Checks**

- In-app browser: added one `หลอดเล็ก`, verified output `1 ถุง`, reset to `0 ถุง`, added again, confirmed the transfer, and received the success message for the holding location.
- Browser console: no errors.
- Responsive check: at 1024 × 900 CSS px, three product cards render as equal 287 px columns and document `scrollWidth` equals 1024 px.
- Focused UI suite: `npx vitest run tests/employee-delivery-workspace.test.tsx` passed, 26/26.
- Demo production build: `npm run build:demo` passed. The existing Vite large-chunk warning remains unchanged.

**Comparison History**

- First pass found a P1 legacy table header inside the card stack, duplicate `data-label` text, and a 1224 px-tall page that pushed actions behind the bottom navigation. The header/pseudo-label rules were overridden, product cards were reduced to the source density, and the viewport was normalized to app-owned content.
- Second pass found P2 route-icon suppression, long-title truncation, and a 73 px bottom navigation overlapping the action row. The truck icon was restored, product titles span the card with reserved stock-pill space, and navigation was reduced to 55 px.
- Final side-by-side pass at 426 × 848 confirms aligned major regions, fully visible actions/navigation, readable untruncated product names, no document overflow, and no remaining P0/P1/P2 layout findings.

final result: passed

---

## 2026-08-04 — Credit debtor store-level redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-04เวลา 08.46.23.png` (2880 × 1800 px). It defines the surrounding production shell, Thai typography, sidebar/topbar, pale operational background, blue active states, border language, and the old mixed shop/bill list that this requirement intentionally replaces.
- Rendered implementation: [outputs/credit-ar-store-table-qa.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-ar-store-table-qa.png) (1440 × 924 px), captured from the local demo in the in-app browser.
- Focused detail evidence: [outputs/credit-ar-shop-drawer-qa.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-ar-shop-drawer-qa.png) (1440 × 900 px), showing the selected shop's credit summary, outstanding bills, receipt history, and receipt-to-bill allocation detail.
- Responsive evidence: [outputs/credit-ar-store-table-mobile-viewport-qa.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-ar-store-table-mobile-viewport-qa.png) (390 × 844 px), plus the full-page responsive capture [outputs/credit-ar-store-table-mobile-qa.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-ar-store-table-mobile-qa.png) (1112 × 1480 rendered pixels).
- Viewport and normalization: desktop was reviewed at 1440 × 900 CSS px and mobile at 390 × 844 CSS px. The source contains Safari/macOS chrome and is a higher-density capture; comparison therefore normalized to the app content region and judged the shared design system plus the intentionally changed information architecture.
- State: admin role, `ลูกหนี้เครดิต` sidebar page, `รายชื่อลูกหนี้` tab, representative unlimited/near-limit/overdue/suspended accounts, an overdue filter pass, BB2 detail drawer, and an expanded receipt allocation.
- Full-view comparison evidence: the source and rendered implementation were inspected together in the same visual review. The new screen preserves the source shell and interaction language while replacing the duplicate shop/bill cards with four summary cards, filters, and one store-level row per debtor.
- Focused-region evidence: the drawer capture verifies the full drill-down hierarchy requested by the specification without reintroducing bill rows into the top-level debtor list.

**Findings**

- No actionable P0/P1/P2 differences remain. The large structural difference from the source is intentional: the old `BB72 · ร้านยอดชา` and `BB72 · C260803-000001` sibling cards are now one `BB72 ร้านยอดชา` table row, with the bill available only inside the detail drawer.
- P3: the ten-column debtor table uses intentional horizontal scrolling at 390 px instead of collapsing financially distinct columns. Browser measurements confirmed the page body remains 390 px wide; overflow is contained inside the table region.

**Required Fidelity Surfaces**

- Fonts and typography: retained the existing Thai font stack, navy hierarchy, muted metadata, bold currency figures, compact operational labels, and numeric alignment.
- Spacing and layout rhythm: retained the fixed shell and low-elevation panels; added a four-card summary grid, a compact filter row, a dense store table, and a right-side detail drawer with consistent radii and dividers.
- Colors and visual tokens: retained the existing blue/white/navy foundation, pale-blue active states, muted blue-gray borders, and semantic green/amber/red/purple statuses.
- Image quality and asset fidelity: existing ice logo and sidebar water artwork remain unchanged. New UI symbols use the installed Phosphor icon set; no emoji, handcrafted SVG, generated image, or placeholder artwork was introduced.
- Copy and content: page/tab/sidebar names, summary labels, store-level credit fields, status priority, bill statuses, receipt history, and receipt allocations match the supplied Thai requirement.

**Interaction And Build Checks**

- In-app browser: opened `ลูกหนี้เครดิต`, verified each store appears once, filtered to overdue stores (2 rows), restored all rows, opened BB2, and expanded receipt `RC260730-000014` to verify its `฿1,150.00` allocation to bill `C260729-000022`.
- Responsive browser check: at 390 × 844 CSS px the page body had no horizontal overflow; the wide debtor table scrolls within its own container.
- Browser console: no errors or warnings.
- Focused UI suite: 37/37 tests passed across credit status, financial operations, and admin navigation.
- Database/contract suite: 8/8 credit-account and collection contracts passed. The focused PGlite integration test also passed for automatic due collection, oldest-first payment, and planned future collection.
- Production build: `npm run build` passed. The existing Vite large-chunk warning remains.
- `git diff --check`: passed.

**Comparison History**

- First visual pass confirmed the source's duplicate shop/bill presentation was removed and that all requested store-level metrics fit the desktop table without clipping.
- Interaction QA verified the overdue filter, store drawer, receipt history, and allocation expansion. No P0/P1/P2 visual or behavioral repair was required after that pass.
- Mobile QA confirmed the document itself remains width-contained; only the intentionally wide financial table scrolls horizontally.

final result: passed

---

## 2026-08-04 — Credit receivables filter layout repair

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-04เวลา 16.14.22.png` (2236 × 556 px), supplied as evidence of the broken filter layout.
- Rendered implementation: [outputs/credit-receivables-layout-fixed-focused.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-receivables-layout-fixed-focused.png) (1280 × 720 px), captured in the in-app browser.
- Combined comparison evidence: [outputs/credit-receivables-layout-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-receivables-layout-comparison.png). The supplied broken crop is above the corrected browser capture.
- Viewport and normalization: desktop implementation used a 1280 × 720 CSS px viewport. The 2236 px-wide source crop was downsampled to 1280 px for the comparison board. Mobile was checked at 390 × 844 CSS px; browser metrics, rather than the browser canvas padding, were used for width-containment judgment.
- State: debtor list with all five optional filters present, default filter values, four store rows, and the table scrolled to its initial left position.

**Findings**

- No actionable P0/P1/P2 differences remain. The source demonstrates the defect: the globally full-width selects cause `ผู้รับผิดชอบ` to expand across most of the second row and leave `เรียงตาม` undersized. The corrected desktop capture keeps all five filters on one row at equal 120 px widths while the search field takes the remaining space.
- At narrower desktop widths, wrapped filters retain the same 120 px basis instead of stretching to fill an incomplete row. At 390 px, the search occupies one row and filters flow into two stable columns without document overflow.

**Full-view Comparison Evidence**

- The combined board shows the broken uneven second row above the corrected single-row filter bar and unchanged debtor table. Surrounding summary cards, sidebar, typography, colors, and table density remain consistent with the existing application.

**Focused Region Comparison Evidence**

- Browser geometry at 1280 px confirmed one filter row: every filter label and select measured 120 px wide, the search measured 298 px, and the controls measured 972 px without body overflow.
- At 390 px, the document `scrollWidth` equaled 390 px. The search measured 308 px; filters measured 120 px and flowed at x=41/171. The table stayed inside a 332 px scroll container with its intentional 1140 px internal table width.

**Required Fidelity Surfaces**

- Fonts and typography: unchanged existing Noto Sans Thai stack, weights, sizes, line heights, wrapping, and numeric hierarchy.
- Spacing and layout rhythm: filter labels now intentionally stack above their controls with a 5 px gap; equal filter widths and end alignment restore a stable toolbar rhythm across complete and wrapped rows.
- Colors and visual tokens: unchanged existing white, pale-blue, navy, muted-border, and semantic status tokens.
- Image quality and asset fidelity: no images or icons were added or replaced; the existing logo, sidebar artwork, search icon, status chips, and detail icon remain intact.
- Copy and content: all labels, options, debtor fields, values, and table headings are unchanged.

**Interaction And Build Checks**

- In-app browser: selecting `เกินกำหนด` in the due-status filter reduced the table to the expected two rows.
- Browser console: no errors or warnings.
- Layout and credit contracts: 5/5 passed.
- Focused financial UI suite: 34/34 passed.
- Production build: passed. The existing Vite large-chunk warning remains unchanged.
- `git diff --check`: passed.

**Comparison History**

- First repair constrained wrapped filters to 132 px, which stopped the runaway expansion but still wrapped `เรียงตาม` at the 1280 px desktop viewport.
- Final repair set a 120 px stable filter basis. The post-fix capture and browser geometry confirm all five filters fit one row at desktop and remain contained on mobile.

final result: passed

---

## 2026-08-04 — Collection run status bar and assignment modal

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-04เวลา 06.46.56.png` (2880 × 1800 px) for the existing collection-run area and page design system, plus `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-04เวลา 06.49.59.png` (342 × 142 px) for the removed aggregate-print action. The requested banner/modal states in the prompt define the intentional replacement behavior.
- Rendered implementation: [outputs/collection-run-status-closed.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-run-status-closed.png) (1280 × 720 px), [outputs/collection-run-status-active.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-run-status-active.png) (1280 × 720 px), and [outputs/collection-run-modal-desktop.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-run-modal-desktop.png) (1280 × 720 px).
- Responsive implementation: [outputs/collection-run-status-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-run-status-mobile.png) (390 × 1122 px full-page) and [outputs/collection-run-modal-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-run-modal-mobile.png) (390 × 844 px viewport).
- Combined comparison evidence: [outputs/collection-run-visual-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-run-visual-comparison.png) (1280 × 765 px). It places the supplied page and print-button references together with the rendered Active status bar.
- Viewport and normalization: desktop used the in-app browser's native 1280 × 720 CSS viewport at device-pixel ratio 2; returned screenshots were CSS-normalized to 1280 × 720. Mobile used 390 × 844 CSS px. The larger source screenshot is shown scaled-to-fit in the comparison board; browser/macOS chrome was excluded from app-layout judgments.
- State: unopened daily collection run; assignment modal with three eligible employees and no initial selection; confirmed Active run assigned to `So (โซ)` with Bangkok start time; mobile unopened and modal states.
- Full-view evidence: the comparison board shows that the new bar retains the existing sidebar/topbar frame, pale operational background, navy hierarchy, muted border language, compact blue actions, and Phosphor icon style while removing the unused print control and the oversized assignment section.
- Focused-region evidence: the same board places the old `พิมพ์ใบเสร็จรวม` button beside the new Active status-bar region. Separate desktop/mobile modal captures verify option cards, selected-count footer, disabled confirmation state, close control, and responsive bottom-sheet layout.

**Findings**

- No actionable P0/P1/P2 differences remain. The change is an intentional replacement rather than a pixel-identical clone: run management is now visible before the summary cards and uses semantic warning/active tones without altering the surrounding collection workspace.
- P3: the start time appears on a second compact line in the implementation instead of inside parentheses on the same line. This keeps the status readable with multiple assigned employee names and on narrow screens.

**Required Fidelity Surfaces**

- Fonts and typography: retained the existing Thai font stack, compact 11–13 px operational labels, navy headings, bold assignee name, controlled line height, and truncation-safe layout.
- Spacing and layout rhythm: the desktop bar is a single 62–64 px row with a right-aligned action; mobile converts to two content columns plus a full-width action. The modal uses the existing 18 px desktop radius and becomes a bottom sheet on mobile with safe-area footer padding.
- Colors and visual tokens: retained the existing white/navy/blue foundation and muted blue-gray borders. Pale amber communicates unopened status; pale green communicates Active status; both remain visually quieter than primary workflow actions.
- Image quality and asset fidelity: existing ice logo/sidebar artwork remain untouched. New UI symbols use the project's installed Phosphor icon set and existing employee avatar behavior; no emoji, handcrafted SVG, CSS illustration, or placeholder image was introduced.
- Copy and content: unopened copy, `เปิดรอบและมอบหมาย`, assignment guidance, selected-employee count, `ยืนยันเปิดรอบ`, Active assignee, Bangkok start time, and `ปิดรอบเก็บเงิน` all match the requested workflow.

**Interaction And Build Checks**

- In-app browser: opened the unopened state, opened the modal, selected `So (โซ)`, confirmed the run, and verified the Active bar with current Bangkok time and the close-run action.
- Accessibility: modal uses `role="dialog"`, `aria-modal`, labelled heading, initial close-button focus, Tab trapping, Escape/backdrop close, body scroll lock, trigger-focus restoration on cancellation, and close-run focus after successful confirmation. Confirmation remains disabled until at least one employee is selected.
- Responsive browser check: 390 × 844 CSS px; status bar action remains within the 390 px document width and the modal renders as a readable bottom sheet.
- Browser console: no errors.
- Focused financial UI suite: `npm run test:ui -- --run tests/financial-operations.test.tsx` passed, 30/30, including stateful open/close transitions, focus restoration, and open failure handling.
- Production build: `npm run build` passed. The existing Vite large-chunk warning remains unchanged.
- `git diff --check`: passed.

**Comparison History**

- Initial implementation preserved the old always-visible collector fieldset below the primary workspace. It was replaced with the requested compact manager-only status bar and portal modal, removing the duplicate lower run-management section.
- The first automated screenshot used a temporary viewport override whose capture scale cropped the right side. QA reset to the browser's native viewport and re-captured the unopened, Active, and modal states at correctly normalized dimensions before judging layout.
- Post-fix browser evidence confirms the full desktop action area, mobile width containment, employee selection, Active state transition, and zero console errors.

**Follow-up Polish**

- P3: if the team prefers the exact single-line sample, the Active copy can be changed to `รอบปัจจุบัน: So (โซ) (เริ่ม 08:00 น.)` at desktop widths while retaining the stacked mobile treatment.

final result: passed

---

## 2026-08-03 — Employee collection queue restoration

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/IMG_3086.PNG` (1320 × 2868 px).
- Rendered implementation: `/private/tmp/employee-collection-implementation.png` (440 × 810 px), captured from the local demo route `?screen=employee-collection-layout` in the Codex in-app browser.
- Viewport and normalization: the source's app-content region was cropped to 1320 × 2430 px (excluding 133 px of top browser chrome and the 305 px Safari toolbar), then normalized from @3x to 440 × 810 CSS px. The implementation was captured at 440 × 810 CSS px.
- State: courier collection page with an open collection run, unselected shop, and the current-day history below the queue.
- Browser-rendered behavior: selecting the first assigned shop opened one accessible payment dialog; the browser console contained no errors.

**Findings**

- [P1] Blocking comparison evidence is unavailable.
  Location: full mobile employee collection page.
  Evidence: both normalized images were captured, but the in-app browser's security policy blocked the required same-input side-by-side comparison board.
  Impact: the required Product Design visual QA loop cannot truthfully classify the restored layout as passed.
  Fix: compare the captured source and implementation in an approved visual-comparison surface, then resolve any P0/P1/P2 differences.

**Required Fidelity Surfaces**

- Fonts and typography: implementation uses the existing Noto Sans Thai stack and preserves the old page hierarchy; same-input visual comparison remains blocked.
- Spacing and layout rhythm: implementation restores the single-column employee queue, full-width refresh action, shop cards, and bottom navigation spacing; same-input visual comparison remains blocked.
- Colors and visual tokens: implementation reuses the existing navy, blue, pale-blue, white, and muted-border palette; same-input visual comparison remains blocked.
- Image quality and asset fidelity: the existing logo and live shop-image behavior are retained; the demo correctly uses the existing no-image storefront state.
- Copy and content: the employee page shows only the old queue workflow and recent receipt history; manager summaries, filtering, and collector-management data are absent.

**Interaction And Build Checks**

- In-app browser: opened the 440 × 810 employee demo, verified the old queue content, selected a shop, and verified the payment dialog.
- Browser console: no errors.
- Focused financial UI suite: `npx vitest run tests/financial-operations.test.tsx` passed, 23/23.
- Production build: `npm run build` passed.

**Comparison History**

- First pass: browser-rendered implementation capture succeeded, but the required combined source/implementation comparison was blocked by the browser URL security policy.

final result: blocked

---

## 2026-08-03 — Store collection desktop workspace

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 3 ส.ค. 2569 17_25_06.png` (1536 × 1024 px).
- Rendered implementation: [outputs/collection-layout-desktop-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-layout-desktop-final.png) (1536 × 1024 px).
- Responsive implementation: [outputs/collection-layout-mobile-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-layout-mobile-final.png) (390 × 844 px), with the receive-payment dialog open.
- Combined comparison evidence: [outputs/collection-layout-comparison-final.jpg](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-layout-comparison-final.jpg) (1536 × 2092 px), with the reference above the implementation.
- Viewport and normalization: reference and desktop implementation are both 1536 × 1024 px at the same page crop. The in-app browser used a 1536 × 1024 CSS viewport. No density resize or crop was needed. Mobile used a 390 × 844 CSS viewport.
- State: collection run open, seven outstanding shops, first shop selected, cash selected, received amount prefilled, and two payments included in today's summary.
- Full-view evidence: the comparison board shows the same sidebar/topbar frame, four summary cards, tabbed/searchable shop table, selected row, fixed right payment panel, and bottom pagination in one viewport.
- Focused-region evidence: the table and right payment panel are legible in the full-resolution comparison board. The separate mobile capture verifies the responsive payment dialog, bill details, quick amounts, allocation summary, and persistent actions.

**Findings**

- No actionable P0/P1/P2 differences remain. The implementation preserves the source's desktop information architecture and dense two-column composition while continuing to expose the existing payment behavior.
- P3: the production data model does not currently expose the shop building/floor label shown under each shop in the reference, so the implementation honestly displays the number of outstanding items instead.
- P3: the right panel reuses the existing detailed charge card rather than reproducing the reference's checkbox allocation table. Oldest-first allocation remains automatic and covered by the financial test suite.

**Required Fidelity Surfaces**

- Fonts and typography: retained Noto Sans Thai, compact table metadata, navy headings, numeric emphasis, controlled truncation, and readable 11–13 px operational labels.
- Spacing and layout rhythm: matched the fixed sidebar, 70 px topbar, four-card summary row, compact filters, seven-row table, selected-row accent, 416 px detail panel, low-radius borders, and low-elevation shadows. Mobile collapses the workspace to one column and keeps the payment form in the existing full-height dialog.
- Colors and visual tokens: retained the blue/white/navy system, pale blue selection, blue primary action, muted borders, and semantic green/orange/purple summary accents.
- Image quality and asset fidelity: retained the supplied ice logo and sidebar water artwork. All UI icons come from the existing Phosphor library; no emoji, handcrafted SVG, or placeholder illustration was added.
- Copy and content: heading, summary labels, search/filter/sort controls, outstanding amounts, document references, dates, status pills, payment methods, received amount, date/time, note, and save action align with the reference workflow.

**Interaction And Build Checks**

- Search reduced the seven-row queue to the single matching coffee shop and restored cleanly.
- Switching to bank transfer selected the method and revealed the required evidence input; switching back to cash restored the cash state.
- The `เก็บเงินแล้ววันนี้` tab rendered the two expected paid rows and returned to the outstanding queue.
- At 390 × 844, selecting the first shop opened one accessible payment dialog with no console warnings or errors.
- Browser console: no errors or warnings on desktop or mobile.
- Focused financial UI suite: `npx vitest run tests/financial-operations.test.tsx --reporter=dot` passed, 23/23.
- Bangkok date-range and financial regression suites passed together, 26/26. The complete UI suite passed, 159/159.
- Production build: `npm run build` passed. The existing Vite large-chunk warning remains unchanged.

**Comparison History**

- Initial pass found a P1 demo-only authorization error banner because the preview fixture still attempted a Supabase load. Demo data now bypasses the remote load; post-fix browser evidence has no banner or console errors.
- Initial pass found a P2 desktop composition mismatch: the payment flow opened only as a modal and duplicated the old shop-card grid below the new table. Desktop now renders the existing payment component inline, while mobile retains the modal; the old assignment/grid section appears only before a collection run is opened.
- The first inline-panel pass left a large empty lower region and let the next financial section enter the source viewport. The panel now includes received date/time, keeps its primary action near the bottom, and moves secondary financial sections below the primary workspace.
- The duplicate queue temporarily made nine focused tests ambiguous. The legacy shop grid now appears only before a run opens, while manager close/reassignment controls remain available without duplicating shop actions.
- Post-review fixes separated complete Bangkok-day totals from the 30-row receipt history, initialized production desktop auto-selection through the normal payment defaults, made status/document/all filters functional, and removed the manager-only open-run action from courier views. The post-fix focused suite passes 23/23.

**Follow-up Polish**

- P3: add building/floor metadata to the collection queue RPC if exact secondary shop copy is required later.

final result: passed

---

## 2026-08-04 — Credit & AR management navigation tab

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-08-04เวลา 06.13.00.png` (2880 × 1800 px), used for the established sidebar, topbar, operational tabs, pale-blue page background, dense table/card treatment, and action hierarchy.
- Rendered implementation: [outputs/credit-ar-management-navbar.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/credit-ar-management-navbar.png) (1280 × 720 px), captured from `?screen=collection-layout` in the in-app browser.
- Viewport and state: desktop 1280 × 720 CSS px, manager collection workspace with `จัดการลูกหนี้ & เครดิต` selected beside `ค้างชำระทั้งหมด`, `ประวัติรับเงิน`, and `ทั้งหมด`.
- Visual comparison evidence: source and implementation were opened and compared in this run. This is an intentional extension of the source: the new tab replaces the collection table/detail pane while retaining the source's surrounding information architecture.

**Findings**

- No actionable P0/P1/P2 differences remain for the shared collection workspace surfaces. The new credit tab uses the same navigation scale, blue active-tab indicator, border/radius language, Thai typography, sidebar/topbar framing, and dense operational card layout.
- The source has no direct Credit & AR equivalent, so the management header, four summary cards, and internal credit views are intentional new content rather than fidelity differences.

**Required Fidelity Surfaces**

- Fonts and typography: existing Thai system stack, navy title hierarchy, compact labels, and bold currency treatment retained.
- Spacing and layout rhythm: credit content is contained within the existing workspace panel; selecting it removes the payment-detail column and uses the full panel width.
- Colors and visual tokens: existing blue/white/navy palette, pale-blue active state, low-elevation panels, muted borders, and semantic overdue red retained.
- Image quality and asset fidelity: existing ice logo and sidebar artwork retained; UI icons use the project’s Phosphor icon library.
- Copy and content: tab exposes approval requests, credit debtor status and available credit, aging buckets, and overdue follow-up actions.

**Interaction And Build Checks**

- In-app browser: selected `จัดการลูกหนี้ & เครดิต` from the same tablist as outstanding and payment history; the workspace switched to the Credit & AR overview and hid the payment detail pane.
- Browser console: no errors or warnings.
- Focused financial UI suite: `npm run test:ui -- tests/financial-operations.test.tsx` passed, 27/27.
- Typecheck and production build: `npx tsc -b` and `npx vite build` passed. The existing large-chunk warning remains unchanged.
- `git diff --check`: passed.

**Comparison History**

- Initial implementation placed Credit & AR below the collection workspace. Follow-up direction moved it into the workspace navigation, beside outstanding and payment-history tabs; post-fix browser evidence confirms the requested placement.

final result: passed

---

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

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

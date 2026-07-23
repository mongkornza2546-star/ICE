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

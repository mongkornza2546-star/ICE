# Design QA — Factory order page

## Comparison target

- Source visual truth: `/Users/bhusitt./Downloads/626CB74F-7DAF-4DF3-8E76-BAA584F574CC.PNG` (1448 × 1086)
- Implementation: `src/FactoryOrderPage.tsx` inside `src/AdminLayout.tsx`
- Preview: `http://localhost:4173/?preview=factory-order`
- Comparison state: selected service date and truck, both ice quantities populated, projected stock visible, confirmation enabled, and recent history populated
- CSS viewport: 1448 × 1086; browser screenshot content: 1448 × 1046 because the in-app browser chrome is outside the captured page

## Visual evidence

- Final implementation: `outputs/factory-order-desktop-final-1448x1086.png`
- Full source/implementation comparison, placed in the same image: `outputs/factory-order-design-comparison-final.png`
- Focused form and summary comparison, placed in the same image: `outputs/factory-order-design-comparison-form.png`
- Mobile evidence: `outputs/factory-order-mobile-frame-390x844.png`

Both the complete page and the dense order-form/summary region were inspected at original resolution.

## Required fidelity surfaces

- Typography: existing Noto Sans Thai is retained; heading, card title, label, value, and helper-text hierarchy follow the reference.
- Layout rhythm: white navigation rail, 72px top bar, page-owned H1, alert, primary form, quick actions/history, and right summary rail match the reference structure.
- Colors and tokens: white/slate surfaces, blue active/primary state, light-blue informational border, subtle card borders, and restrained shadows remain consistent.
- Asset fidelity: the generated transparent ice-cube logo is used in the header; the existing high-resolution ice/water artwork is reused in the navigation rail.
- Copy and content: the screen describes the real contract—factory receipt is recorded by service date and receiving truck, without requiring an open delivery round.
- Responsive behavior: 375, 390, 768, and 1024px layouts were checked with no horizontal overflow. At narrow widths the summary follows the form, controls meet the 44px touch target, history becomes cards, and the navigation drawer opens/closes with Escape and restores focus.

## Iteration history

### Iteration 1

- [P1] Above-the-fold content sat lower than the reference because the page repeated an eyebrow/date chip and used an oversized H1.
- [P1] The first summary rail was too narrow, making the main form feel heavier than the source.
- Fix: removed duplicate page metadata, reduced H1 size, tightened vertical spacing, widened the desktop summary rail to 350px, and compacted feedback/note rows.

### Iteration 2

- Full-page and focused comparisons show the same primary hierarchy, column split, order controls, summary emphasis, and visual rhythm as the reference.
- No remaining actionable P0, P1, or P2 visual issue was found.

## Intentional deviations

- Search, notifications, pricing, route, driver, payment, and delivery-time fields from the visual example are not shown because the current application has no persisted source-of-truth contract for them.
- The implementation uses `ถุง` instead of the example's mixed bag labels and avoids adding unlike units into one misleading total.
- Delivery-round selection is intentionally absent: a factory order is a day/truck stock receipt, while delivery rounds group workers and shop sales.

## Interaction and technical checks

- Quick-add updated tube ice to 100 bags and crushed ice to 50 bags; projected stock and the confirmation CTA updated immediately.
- Confirmation success/reset behavior was exercised in preview mode.
- Mobile drawer keyboard behavior and responsive ordering passed.
- Browser console contained no errors or warnings during the interaction pass.
- `npm test`: 37/37 passed.
- `npm run build`: passed (only the existing Vite chunk-size warning remains).
- `git diff --check`: passed.

final result: passed

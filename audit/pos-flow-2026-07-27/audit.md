# POS delivery flow audit — 2026-07-27

## Scope

- Compared the current manager entry screen supplied by the user with `docs/pos-delivery-and-payment-plan.md`.
- Captured the local demo flow at desktop and mobile widths.
- Inspected the delivery workspace, shop picker, POS review, payment flow, responsive CSS, role routing, and focused UI tests.
- Focused UI tests: 22 passed.

## Evidence

1. `01-current-entry.png` — current deployed manager entry screen supplied by the user.
2. `02-courier-start.png` — local courier demo before selecting a round.
3. `03-courier-round-selected.png` — courier stock transfer and shop list after selecting a round.
4. `04-pos-empty.png` — desktop POS after selecting a shop.
5. `05-pos-cart.png` — desktop POS with one cart line.
6. `06-mobile-items.png` — mobile item-entry step at 390px.
7. `07-mobile-review.png` — mobile review step at 390px.

## Overall verdict

The product has a usable POS component after a shop is selected, but the complete delivery flow still does not meet the plan. The manager entry flow remains legacy, the no-round state blocks the user without a recovery action, and several acceptance requirements are either missing or contradicted by current tests.

## Flow health

1. Manager entry and no-round state — **Poor / blocked**
   - Stock quantity is requested before the shop.
   - With no open round, every control is disabled and no actionable recovery is shown.
2. Courier stock and shop selection — **Fair**
   - Stock ownership and shop filtering are understandable.
   - Stock transfer dominates the page and pushes the primary delivery task below the fold.
3. Desktop POS after shop selection — **Fair**
   - Product selection, keypad, cart, stock quantity, and source label are present.
   - The shop list disappears, so desktop is not the single three-part workspace in the plan.
4. Mobile item entry — **Good with gaps**
   - The three-step navigation and draft retention work.
   - Product steppers duplicate the keypad and make the page longer.
5. Mobile review — **Fair**
   - The cart survives the step transition and the selected shop remains visible.
   - Clear-all and full financial context are missing from the demo evidence.
6. Immediate payment sheet — **Not visually verified**
   - The local demo does not implement the financial POS context or payment gateway.
   - Code inspection found a missing client-side non-cash overpayment guard.

## Prioritized findings

### P0 — fix before operational use

1. Remove the manager/admin “stock before shop” branch. Select the shop first, then load the server-owned POS context and resolved stock source.
2. Add an explicit no-open-round state with the cause and recovery action. The current screen tells the user to choose a round while rendering no round selector.
3. Do not carry a manager’s quantities silently from one shop to another. Confirm a shop change when a draft exists, preserve the draft on cancel, and clear it on confirmed change.
4. Never accept a pre-shop quantity that has not been checked against the selected shop’s source stock. Clamp or reject against `posContext.items[].stock_quantity`.

### P1 — required to meet the written plan

1. Rebuild desktop/tablet as one workspace: compact shop list, products, and quantity/cart summary visible together.
2. Add “clear cart” in addition to per-line delete.
3. Resolve signed URLs for `ice-type-images` and render the configured product image, with the icon as fallback.
4. Declare a real CSS container for the workspace or use a correct content-width breakpoint. The named `@container employee-workspace` rule currently has no matching `container-name`; at 901–1050px the sidebar can leave less width than the three columns require.
5. Block transfer/QR amounts above the outstanding amount in the immediate-payment sheet before submit. The server rejects this safely, but the POS currently lets the user attempt it.
6. Show the credit rule/due-date context in the review before confirmation and show the resulting due date after a credit delivery.
7. Update the local demo with POS prices, payment profiles, financial result, and payment recording. It currently displays “no price” while allowing the demo submission path, so it cannot be used for financial visual QA.
8. Replace the focused test that asserts “stock step before shop step” with tests for shop-first behavior, shop-change confirmation, no-round recovery, stock clamping, clear-all, product images, and immediate non-cash overpayment.

### P2 — clarity and accessibility

1. Remove the redundant per-product steppers when the keypad is present, especially for six product types.
2. Make the top date and location either real controls or remove the caret icons; they are non-interactive spans that look selectable.
3. Announce loading and success changes consistently with `aria-live`/`role=status`; `FinancialOperations` success text is not currently announced.
4. Improve disabled/empty-state copy so the user knows why the page is locked and what to do next.
5. Fix joined success copy such as `รถเข็นคัน 1และร้านปลายทาง` by adding the missing space.

## Evidence limits

- The deployed flow could not proceed beyond the supplied no-round screen, so the deployed post-shop and payment states were not captured.
- Desktop and mobile POS states after shop selection were captured from the repository’s local demo.
- Screenshot review cannot establish full WCAG compliance. Keyboard behavior, focus order, screen-reader output, contrast ratios, and zoom behavior still need dedicated verification.

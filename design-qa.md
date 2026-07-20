**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-20เวลา 16.07.33.png`.
- Browser-rendered implementation: `/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/stock-layout-desktop-top.png`.
- Side-by-side comparison: `/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/stock-layout-comparison.png`.
- Responsive evidence: `/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/stock-layout-mobile.png`.
- Viewports: desktop 1440 × 1000, tablet 768 × 900, mobile 390 × 844.
- State: transfer tab active, first destination selected, quantities 10 + 3 + 1, three cart lines totaling 14 units.

**Full-view Comparison Evidence**

- The source and browser capture were placed in one side-by-side image before review.
- Both use the same information sequence: destination selection, product selection, note, and a right-side confirmation summary.
- Desktop keeps a three-column destination/product grid and sticky summary card. Tablet and mobile move the summary below the main form.
- The production shell and main stock tabs remain visible around the recreated flow; this is an intentional product integration rather than part of the source crop.

**Focused Region Comparison Evidence**

- A separate focused crop was not required because the normalized side-by-side comparison keeps the complete flow readable at the source size.
- The selected destination, selected product cards, quantity controls, cart lines, total card, notice, CTA, and clear action are all legible in the combined evidence.

**Findings**

- No actionable P0/P1/P2 layout differences remain.
- [P3] The implementation uses the existing Phosphor avatar and product icon family instead of the source's illustrated people and ice imagery. This is intentional because the user clarified that only the layout should be matched.
- [P3] The application tab bar sits above step 1 and slightly reduces the available vertical space compared with the isolated source crop. It preserves the existing stock-management navigation and does not change the requested layout hierarchy.

**Required Fidelity Surfaces**

- Fonts and typography: Noto Sans Thai, compact bold section titles, subdued metadata, and large quantity figures preserve the source hierarchy without clipped or awkward Thai wrapping.
- Spacing and layout rhythm: the desktop grid, 20px main/summary gap, compact card spacing, note field, sticky summary, and 8–14px radii align with the source. No horizontal overflow occurs at 390px or 768px.
- Colors and visual tokens: the existing blue palette is reused for selected borders, checks, quantity actions, notice, totals, and CTA; red is limited to zero stock.
- Image quality and asset fidelity: no generated raster imagery was used after the user limited scope to layout. Existing Phosphor icons remain crisp at all tested widths.
- Copy and content: Thai step labels, visible source selector, destination location metadata, stock availability, units, total count, total quantity, notice, confirmation, and clear action are complete and coherent.
- States and interactions: destination cards expose `aria-pressed`; quantity controls support 0.5 increments and +1/+5/+10 shortcuts; cart totals update live; the CTA stays disabled until a destination and items are valid; clear and successful submission reset the cart and destination.
- Accessibility: visible focus styles are retained, controls are labeled, status/error messages have live semantics, and mobile controls meet the intended touch size.

**Comparison History**

- Initial finding [P2]: the legacy current-stock overview consumed the top of the page, pushing step 1 below the fold and breaking the source hierarchy.
  Fix: hide that overview only in the transfer flow while keeping its stock values on product cards and preserving it for damage, count, and return flows.
  Post-fix evidence: `outputs/stock-layout-desktop-top.png` and `outputs/stock-layout-comparison.png` show step 1 immediately below the stock tabs.
- Initial finding [P2]: responsive behavior was unverified.
  Fix: test 768px and 390px browser viewports; summary moves after the form and document width equals viewport width at both breakpoints.
  Post-fix evidence: `outputs/stock-layout-mobile.png`; measured widths were 390/390 and 768/768.

**Interaction And Console Checks**

- Selected quantities 10, 3, and 1 and confirmed the summary displayed 3 types / 14 units.
- Confirm CTA changed from disabled to enabled after a valid destination and item selection.
- Tablet summary appeared below the main form.
- Browser console errors checked: none.
- Targeted UI regression: `tests/manager-stock-control.test.tsx` passed 9/9.
- Production and demo builds passed.
- Full repository baseline remains 98/109 because the 11 known failures documented in the supplied plan (9 brittle source-regex checks and 2 truck-location contract checks) are outside this layout-only change.

**Implementation Checklist**

- No P0/P1/P2 fixes remain.
- Optional follow-up: replace generic icons with real employee and ice images if visual asset fidelity is later added to scope.

**Follow-up Polish**

- Consider container queries if the sidebar width becomes configurable; current viewport breakpoints pass the tested product shell.

final result: pending refreshed visual capture after the visible source-selector fix

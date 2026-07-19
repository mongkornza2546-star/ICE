**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-19เวลา 23.56.56.png`.
- Intended implementation: the shop catalog and editor dialog in `src/ShopSettings.tsx`.
- Viewport: desktop source at 2000 × 1280; responsive dialog also targets widths below 680px.
- State: authenticated admin, shop catalog loaded, then a shop card selected.

**Evidence**

- The source image was opened and inspected at original resolution.
- Browser-rendered implementation screenshot: unavailable. The local application requires an authenticated Supabase admin session and the repository has no local admin fixture or test credentials.
- Interaction evidence: `tests/shop-settings-card-catalog.test.tsx` verifies opening the editor as a dialog, closing it with Escape/the close button/the backdrop, and cycling all/active/inactive filters.
- Automated UI result: 23/23 Vitest tests passed on 2026-07-20.
- Production build: `npm run build` passed on 2026-07-20.

**Full-view Comparison Evidence**

- Source: the catalog, search field, count, and card grid are visible above the fold; the previous editor was below the grid.
- Implementation: code and interaction tests confirm the editor is removed from document flow and rendered in a fixed modal backdrop. A same-state browser screenshot could not be captured, so visual proportions cannot be compared side by side.

**Focused Region Comparison Evidence**

- Source toolbar: search occupies the available width and the count sits at the right edge.
- Implementation toolbar: the status filter is inserted between search and count, using the existing 46px control height and blue active-state tokens. Focused screenshot comparison remains blocked by authentication.

**Findings**

- [P2] Authenticated visual comparison is unavailable.
  Location: shop catalog toolbar and shop editor dialog.
  Evidence: the source is available, but the local implementation cannot reach the authenticated shop route without an admin session.
  Impact: exact modal sizing, scrolling density, and responsive wrapping have not been visually confirmed in a real browser.
  Fix: open the local or deployed build while authenticated, select a shop, and capture desktop plus narrow-width modal states.

**Required Fidelity Surfaces**

- Fonts and typography: existing application typography and weights are preserved; browser comparison blocked.
- Spacing and layout rhythm: existing catalog spacing is preserved, with a 46px filter control and a bounded 920px dialog; browser comparison blocked.
- Colors and visual tokens: existing blue, border, radius, backdrop, and shadow tokens are reused; browser comparison blocked.
- Image quality and asset fidelity: existing shop photos and Phosphor fallback icons are unchanged.
- Copy and content: existing Thai shop form content is unchanged; filter labels are “ทั้งหมด”, “เฉพาะที่ใช้งาน”, and “เฉพาะที่พักใช้งาน”.

**Comparison History**

- Initial issue: selecting a card scrolled to an editor below the catalog. Fix: editor moved into a fixed, scroll-contained dialog and background scrolling is locked.
- Initial issue: no catalog status filter. Fix: added a visible filter control that cycles all/active/inactive and updates the result count.
- Post-fix visual evidence: blocked by authenticated route; post-fix interaction and build evidence passed.

**Implementation Checklist**

- Capture the authenticated shop catalog with a dialog open at desktop width.
- Capture the same state below 680px and confirm header/actions do not wrap awkwardly.
- Compare both captures with the source before marking visual QA passed.

**Follow-up Polish**

- None identified without the authenticated browser capture.

final result: blocked

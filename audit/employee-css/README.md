# Employee CSS build — 2026-10-24

`npm run build:employee` uses `src/employee.css` and the PostCSS plugin in
`scripts/employee-styles.mjs`. The plugin excludes selectors beginning with
explicit management-only class namespaces, including those in imported CSS.
It preserves the order and specificity of all remaining selectors, including
mixed selector lists and responsive overrides. The regular web build continues
to include the complete stylesheet.

There is one source of truth (`src/index.css` and its imports), not a copied
employee stylesheet that needs separate maintenance. Keep employee/shared UI
out of the excluded namespaces. In particular, `credit-ar`, `image-preview`,
`event-spin`, fonts, and generic controls are shared and must stay available.
The filter deliberately keeps selectors whose ownership is ambiguous (for
example a class inside `:not()` or `:is()`).

## Measurements

Fresh production builds of the same source, before and after this change:

| Employee CSS | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Uncompressed bytes | 352,792 | 191,182 | 45.8% |
| Gzip bytes | 61,940 | 33,058 | 46.6% |

The JavaScript bundle is byte-identical. This is a CSS payload reduction, not
an Android frame-rate or startup-time benchmark. No APK was installed or
published as part of this change.

## Validation

- TypeScript and both production targets build successfully.
- Ten focused Node tests and 43 UI tests pass, covering employee navigation,
  shop picking, events, billing, payment permissions, printer fonts and layout.
- CSS tests preserve shared declarations and media context and check cascade
  order, mixed selector lists, pseudo-selectors, fonts and animations.
- All 743 class names removed from the built employee CSS were checked against
  the source modules in `employee-build.json`; no matching source tokens remain.
- Browser comparison using the real `EmployeeShopPicker` with synthetic data at
  390px: 294 DOM elements have identical sampled computed styles (dimensions,
  display, spacing, color, background, font, borders and overflow). Both shop
  lists and photo preview dialogs were visually checked.
- The regular web build still contains admin, accounting and employee styles.

Run the CSS regression checks with `node --test tests/employee-styles.test.mjs`.

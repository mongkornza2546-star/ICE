import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssPath = new URL('../src/index.css', import.meta.url);

test('shop picker keeps the responsive desktop grid and uses the photo-first row only on narrow screens', async () => {
  const css = await readFile(cssPath, 'utf8');
  const narrowScreenOverrides = css.split(
    '/* Prioritize storefront photos on narrow screens without overriding the desktop grid. */',
  )[1];

  assert.match(css, /@media \(min-width: 1180px\) \{\s*\.employee-shop-grid \{ grid-template-columns: repeat\(5, minmax\(0, 1fr\)\); \}/);
  assert.match(narrowScreenOverrides, /^\s*@media \(max-width: 679px\) \{/);
  assert.match(narrowScreenOverrides, /\.employee-shop-tile \{ min-height: 140px;/);
});

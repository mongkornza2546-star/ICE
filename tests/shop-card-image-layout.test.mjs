import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssPath = new URL('../src/index.css', import.meta.url);

test('compact shop cards hide signed source images without changing the final card grid', async () => {
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /\.shop-directory-card \{[^}]*grid-template-rows: minmax\(0, 1fr\) auto;[^}]*min-height: 223px;/);
  assert.match(css, /\.shop-directory-card__source-image \{[^}]*display: none;/);
  assert.match(css, /\.shop-card-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
});

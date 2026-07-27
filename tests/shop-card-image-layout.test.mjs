import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssPath = new URL('../src/index.css', import.meta.url);

test('shop cards visibly reserve a photo area without changing the final card grid', async () => {
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /\.shop-directory-card \{[^}]*grid-template-rows: 116px minmax\(0, 1fr\) auto;[^}]*min-height: 339px;/);
  assert.match(css, /\.shop-directory-card__visual img \{[^}]*object-fit: cover;/);
  assert.match(css, /\.shop-card-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
});

test('shop table keeps the shop code and status in a stacked heading cell', async () => {
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /\.shop-card-grid--list \.shop-directory-card__heading \{[^}]*grid-column: 1;[^}]*display: grid;[^}]*gap: 4px;/);
  assert.doesNotMatch(css, /\.shop-card-grid--list \.shop-directory-card__heading \{\s*display: contents;/);
});

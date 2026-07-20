import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssPath = new URL('../src/index.css', import.meta.url);

test('shop card images stay within the visual grid area', async () => {
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /\.shop-directory-card \{[^}]*grid-template-rows: 126px minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.shop-directory-card__visual \{[^}]*min-height: 0;/);
  assert.match(css, /\.shop-directory-card__visual img \{[^}]*position: absolute;[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%;/);
});

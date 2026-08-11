import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');

test('collection shop photos cannot cover shop details on iPad Safari', () => {
  assert.match(
    css,
    /\.financial-ops__shop-card\s*\{[^}]*grid-template-rows:\s*120px\s+minmax\(98px,\s*auto\);/,
  );
  assert.match(
    css,
    /\.financial-ops__shop-visual\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/,
  );
  assert.match(
    css,
    /\.financial-ops__shop-visual\s*>\s*img\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*object-fit:\s*cover;/,
  );
});

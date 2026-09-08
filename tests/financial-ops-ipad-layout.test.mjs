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

test('collection filters stack before the tablet sidebar makes them overflow', () => {
  assert.match(
    css,
    /@media\s*\(min-width:\s*760px\)\s*and\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\.financial-ops__queue-filters\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?\.financial-ops__queue-filters\s+\.financial-ops__queue-search\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/,
  );
});

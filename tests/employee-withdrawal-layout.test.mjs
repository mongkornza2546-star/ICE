import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stylesheet = readFileSync(
  new URL('../src/index.css', import.meta.url),
  'utf8',
);

test('withdrawal cards avoid overlapping controls at compact desktop widths', () => {
  assert.match(
    stylesheet,
    /\.employee-workspace--withdrawal \.employee-quantity-stepper\s*\{[^}]*grid-template-columns:\s*minmax\(44px,\s*1fr\)\s+minmax\(48px,\s*56px\)\s+minmax\(44px,\s*1fr\);/s,
  );
  assert.match(
    stylesheet,
    /@container\s+employee-workspace\s*\(max-width:\s*840px\)\s*\{[\s\S]*?\.employee-workspace--withdrawal \.employee-stock-table\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
  );
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the billing date pill keeps its calendar and date on one row', () => {
  const stylesheet = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  assert.match(
    stylesheet,
    /\.context-pill--date-select\s*\{[^}]*flex-direction:\s*row;/,
  );
});

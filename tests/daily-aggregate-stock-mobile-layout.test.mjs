import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stylesheet = readFileSync(
  new URL('../src/stock-layout.css', import.meta.url),
  'utf8',
);

test('daily aggregate count details are not constrained to the unit label width', () => {
  assert.doesNotMatch(stylesheet, /\.input-row\s+small\s*\{[^}]*width:\s*20px;/s);
  assert.match(
    stylesheet,
    /\.input-row\s+\.input-wrapper\s*>\s*small\s*\{[^}]*width:\s*20px;/s,
  );
  assert.match(
    stylesheet,
    /\.input-row\s*>\s*span\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s,
  );
});

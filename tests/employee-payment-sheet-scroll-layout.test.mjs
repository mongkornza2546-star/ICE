import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('inline employee payment sheet uses the page scroller', () => {
  assert.match(
    css,
    /\.employee-payment-sheet\.financial-ops__payment-card\s*\{[^}]*max-height:\s*none;[^}]*overflow-y:\s*visible;[^}]*\}/,
  );
});

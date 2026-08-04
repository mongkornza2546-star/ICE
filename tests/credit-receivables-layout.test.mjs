import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stylesheet = readFileSync(
  new URL('../src/index.css', import.meta.url),
  'utf8',
);

test('credit receivable filters keep stable widths when global form controls are full width', () => {
  assert.match(
    stylesheet,
    /\.credit-ar__customers \.financial-ops__receivable-controls > label:not\(\.credit-ar__search\) \{[^}]*width: min\(120px, 100%\);[^}]*display: grid;[^}]*flex: 0 1 120px;/s,
  );
  assert.match(
    stylesheet,
    /\.credit-ar__customers \.financial-ops__receivable-controls > label:not\(\.credit-ar__search\) select \{[^}]*min-width: 0;[^}]*width: 100%;/s,
  );
});

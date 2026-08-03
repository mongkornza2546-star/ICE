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

test('daily aggregate count cards keep identity and count controls on one desktop row', () => {
  assert.match(
    stylesheet,
    /\.daily-stock-count-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*460px\),\s*1fr\)\);/s,
  );
  assert.match(
    stylesheet,
    /\.daily-stock-count-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;[^}]*align-items:\s*center;/s,
  );
  assert.match(
    stylesheet,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.daily-stock-count-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
  );
});

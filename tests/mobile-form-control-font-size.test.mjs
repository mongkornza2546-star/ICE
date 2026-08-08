import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('phone form controls use the iOS-safe 16px minimum without shrinking large numeric fields', () => {
  const safeguard = css.slice(css.indexOf('/* Prevent phone browsers from zooming focused form controls. */'));

  assert.notEqual(safeguard, css);
  assert.match(safeguard, /@media \(max-width:\s*1024px\)/);
  assert.match(safeguard, /input:not\(\[type="checkbox"\]\)/);
  assert.match(safeguard, /:not\(\[type="radio"\]\)/);
  assert.match(safeguard, /:not\(\[type="range"\]\)/);
  assert.match(safeguard, /:not\(\[type="file"\]\)/);
  assert.match(safeguard, /:not\(\[type="hidden"\]\)/);
  assert.match(safeguard, /font-size:\s*1rem !important/);
  assert.match(safeguard, /\.employee-quantity-value input[\s\S]*font-size:\s*1\.25rem !important/);
  assert.match(safeguard, /\.employee-workspace--withdrawal \.employee-quantity-value input[\s\S]*font-size:\s*1\.35rem !important/);
  assert.match(safeguard, /\.quantity-stepper input[\s\S]*font-size:\s*1\.35rem !important/);
  assert.match(safeguard, /\.financial-ops__modal \.financial-ops__payment-amount input[\s\S]*font-size:\s*1\.35rem !important/);
});

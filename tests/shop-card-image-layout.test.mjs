import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('shop card images have a definite desktop height for Safari', () => {
  assert.match(
    css,
    /\.shop-card-grid--grid \.shop-directory-card__visual\s*\{\s*height:\s*116px;\s*\}/,
  );
});

test('mobile shop card images keep their full-height side layout', () => {
  const mobileRules = css.match(/@media \(max-width: 680px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(
    mobileRules,
    /\.shop-card-grid--grid \.shop-directory-card__visual\s*\{\s*height:\s*auto;\s*\}/,
  );
});

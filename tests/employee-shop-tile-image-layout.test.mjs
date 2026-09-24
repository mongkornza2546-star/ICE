import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('employee shop tile image button and visual enforce a fixed 1:1 aspect ratio to avoid layout shift', () => {
  assert.match(
    css,
    /\.employee-shop-tile\s*\{[^}]*height:\s*160px;[^}]*grid-template-columns:\s*160px minmax\(0, 1fr\);/,
  );
  // Ensure no aspect-ratio: auto exists for employee-shop-tile__visual
  assert.equal(
    css.includes('.employee-shop-tile__visual { height: 100%; min-height: 140px; aspect-ratio: auto; }'),
    false,
  );
  assert.equal(
    css.includes('.employee-shop-tile__visual { height: 100%; min-height: 76px; aspect-ratio: auto; }'),
    false,
  );

  // Ensure fixed 1:1 square ratio is enforced on both image-button and visual container
  assert.match(
    css,
    /\.employee-shop-tile__image-button\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1;/,
  );
  assert.match(
    css,
    /\.employee-shop-tile__visual\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1;/,
  );
  assert.match(
    css,
    /\.employee-shop-tile__visual img\s*\{[^}]*object-fit:\s*cover;/,
  );
});

test('mobile employee shop tile images retain fixed 1:1 aspect ratio', () => {
  const matches = css.matchAll(/@media \(max-width: 390px\) \{([\s\S]*?)\n\}/g);
  let shopTileRule = '';
  for (const match of matches) {
    if (match[1].includes('.employee-shop-tile')) {
      shopTileRule = match[1];
      break;
    }
  }
  assert.ok(shopTileRule.length > 0, 'Must have a 390px media query for .employee-shop-tile');
  assert.match(
    shopTileRule,
    /\.employee-shop-tile\s*\{[^}]*height:\s*126px;[^}]*grid-template-columns:\s*126px minmax\(0, 1fr\);/,
  );
  assert.match(
    shopTileRule,
    /\.employee-shop-tile__image-button\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1;/,
  );
  assert.match(
    shopTileRule,
    /\.employee-shop-tile__visual\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1;/,
  );
});

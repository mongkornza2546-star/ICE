import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const stylesheet = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const fontPath = new URL('../public/fonts/NotoSansThai-Variable.ttf', import.meta.url);
const licensePath = new URL('../public/fonts/OFL.txt', import.meta.url);

test('Thai receipt font is bundled for offline Android printing', () => {
  assert.match(stylesheet, /url\(['"]?\/fonts\/NotoSansThai-Variable\.ttf['"]?\)/);
  assert.doesNotMatch(stylesheet, /fonts\.(?:googleapis|gstatic)\.com/);
  assert.equal(existsSync(fontPath), true);
  assert.ok(statSync(fontPath).size > 100_000);
  assert.equal(existsSync(licensePath), true);
});

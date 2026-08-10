import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');

test('reference settings can shrink inside the mobile viewport', () => {
  for (const selector of [
    '.reference-settings-page',
    '.ref-split-layout',
    '.ref-left-panel',
    '.ref-right-panel',
  ]) {
    const escapedSelector = selector.replace('.', '\\.');
    assert.match(css, new RegExp(`${escapedSelector}\\s*\\{[^}]*min-width:\\s*0;`));
  }
});

test('reference settings use the standard compact page gutter on phones', () => {
  assert.match(
    css,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.admin-shell--reference-settings\s+\.admin-content\s*\{\s*padding:\s*14px\s+12px\s+24px;/,
  );
});

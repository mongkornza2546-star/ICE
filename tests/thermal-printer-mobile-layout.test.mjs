import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');

test('the Android printer button clears the employee bottom navigation on phones', () => {
  assert.match(
    css,
    /@media\s*\(max-width:\s*759px\)[\s\S]*?\.thermal-printer-fab\s*\{[^}]*bottom:\s*calc\(62px\s*\+\s*env\(safe-area-inset-bottom\)\);/,
  );
});

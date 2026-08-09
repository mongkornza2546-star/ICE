import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the mobile viewport cannot zoom out below the device width', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"\s*\/?>/i)?.[1] ?? '';

  assert.match(viewport, /(?:^|,\s*)width=device-width(?:\s*,|$)/);
  assert.match(viewport, /(?:^|,\s*)initial-scale=1(?:\.0)?(?:\s*,|$)/);
  assert.match(viewport, /(?:^|,\s*)minimum-scale=1(?:\.0)?(?:\s*,|$)/);
});

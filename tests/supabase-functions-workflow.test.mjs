import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/deploy-supabase-functions.yml', import.meta.url);

test('Edge Function type checks resolve npm dependencies before deploy', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const checkCommands = workflow.match(/deno check[^\n]+/g) ?? [];

  assert.equal(checkCommands.length, 2);
  for (const command of checkCommands) {
    assert.match(command, /--node-modules-dir=auto/);
  }
});

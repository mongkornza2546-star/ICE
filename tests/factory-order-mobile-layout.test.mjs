import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

test('factory order date field can shrink inside the mobile form card', () => {
  assert.match(declarationsFor('.factory-order-fields label'), /min-width:\s*0/);
  assert.match(declarationsFor('.factory-order-fields .field-with-icon'), /min-width:\s*0/);
  assert.match(declarationsFor('.factory-order-fields .field-with-icon input'), /min-width:\s*0/);
  assert.match(declarationsFor('.factory-order-fields .field-with-icon input'), /max-width:\s*100%/);
});

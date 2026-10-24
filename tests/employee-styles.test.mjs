import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import { employeeStyles } from '../scripts/employee-styles.mjs';

test('employee CSS preserves shared selectors, specificity and responsive order', async () => {
  const source = `
    :root { --blue: blue; }
    .admin-shell, .employee-shell { color: var(--blue); }
    .employee-shell { color: green; }
    @media (max-width: 600px) {
      .accounting-page { display: grid; }
      .employee-shell, .reference-form { color: red; }
      .employee-shell { padding: 12px; }
    }
    @media (min-width: 900px) { .manager-dashboard { display: grid; } }
    :not(.admin-shell) { box-sizing: border-box; }
    :is(.employee-shell, .admin-shell) { min-width: 0; }
    [data-label=".admin-shell"] { font-weight: 700; }
    @keyframes event-spin { to { transform: rotate(360deg); } }
  `;
  const { root } = await postcss([employeeStyles()]).process(source, { from: undefined });
  const rules = [];
  root.walkRules((rule) => rules.push([rule.selector, rule.nodes.map(String).join(';')]));
  assert.deepEqual(rules, [
    [':root', '--blue: blue'],
    ['.employee-shell', 'color: var(--blue)'],
    ['.employee-shell', 'color: green'],
    ['.employee-shell', 'color: red'],
    ['.employee-shell', 'padding: 12px'],
    [':not(.admin-shell)', 'box-sizing: border-box'],
    [':is(.employee-shell, .admin-shell)', 'min-width: 0'],
    ['[data-label=".admin-shell"]', 'font-weight: 700'],
    ['to', 'transform: rotate(360deg)'],
  ]);
  const media = [];
  root.walkAtRules('media', (rule) => media.push(rule.params));
  assert.deepEqual(media, ['(max-width: 600px)']);
});

test('actual employee bills, photo previews, fonts and mobile overrides survive filtering', async () => {
  for (const file of ['index.css', 'stock-layout.css']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const before = postcss.parse(source);
    const { root: after } = await postcss([employeeStyles()]).process(source, { from: undefined });
    const shared = /^(?:\.(?:employee-|financial-ops|collection-run|daily-credit|credit-ar|image-preview|thermal-printer|language-switcher|primary-button|event-spin)|:root|html|body|button)/;
    function retainedRules(root) {
      const result = [];
      root.walkRules((rule) => {
        for (const selector of postcss.list.comma(rule.selector).filter((value) => shared.test(value))) {
          result.push({ selector, declarations: rule.nodes.map(String), context: rule.parent.type === 'atrule' ? rule.parent.toString().split('{')[0].trim() : null });
        }
      });
      return result;
    }
    assert.deepEqual(retainedRules(after), retainedRules(before), file);
    const fonts = (root) => {
      const result = [];
      root.walkAtRules('font-face', (rule) => result.push(rule.toString()));
      return result;
    };
    assert.deepEqual(fonts(after), fonts(before));
    assert.doesNotMatch(after.toString(), /\.(?:accounting-page|admin-shell|manager-dashboard|ref-stats-grid|collection-desk__header|stock-layout-panel)\b/);
    assert.ok(after.toString().length < source.length * 0.7, `${file} should omit substantial management CSS`);
  }
});

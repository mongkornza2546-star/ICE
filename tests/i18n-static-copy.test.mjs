import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const dictionary = ts.createSourceFile('legacyUiTranslations.ts', readFileSync(new URL('../src/legacyUiTranslations.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const translated = new Set();
function collectTranslations(node) {
  if (ts.isPropertyAssignment(node)) translated.add(node.name.text);
  ts.forEachChild(node, collectTranslations);
}
collectTranslations(dictionary);
const hasThai = (value) => /[ก-๙]/.test(value) && value.trim() !== '฿';
const textAttributes = new Set(['placeholder', 'title', 'aria-label', 'alt', 'data-label', 'label', 'description', 'detail', 'message', 'heading', 'submitLabel', 'text']);
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(name) : /\.tsx?$/.test(name) ? [name] : [];
  });
}

test('screen copy is translated explicitly, with catalog coverage for literal messages', () => {
  const missing = [];
  for (const file of sourceFiles(root)) {
    if (file.endsWith('/i18n.tsx') || file.endsWith('/legacyUiTranslations.ts')) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const report = (node, issue) => missing.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${issue}`);
    function renderedExpression(node) {
      if (!node) return;
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && hasThai(node.text)) report(node, `untranslated copy: ${node.text}`);
      if (ts.isConditionalExpression(node)) { renderedExpression(node.whenTrue); renderedExpression(node.whenFalse); }
      if (ts.isParenthesizedExpression(node)) renderedExpression(node.expression);
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
        renderedExpression(node.left); renderedExpression(node.right);
      }
      if (ts.isTemplateExpression(node) && hasThai(node.head.text + node.templateSpans.map((span) => span.literal.text).join(''))) report(node, 'untranslated UI template');
    }
    function visit(node) {
      if (ts.isJsxText(node) && hasThai(node.text)) report(node, 'untranslated JSX text');
      if (ts.isJsxAttribute(node) && textAttributes.has(node.name.text)) {
        if (node.initializer && ts.isStringLiteral(node.initializer) && hasThai(node.initializer.text)) report(node, 'untranslated text attribute');
        if (node.initializer && ts.isJsxExpression(node.initializer)) renderedExpression(node.initializer.expression);
      }
      if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) renderedExpression(node.expression);
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'translateUi') {
        const key = node.arguments[0];
        if (key && ts.isStringLiteral(key) && hasThai(key.text) && !translated.has(key.text.trim())) report(key, `missing catalog entry: ${key.text}`);
      }
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'option'
        && !node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.text === 'value')) report(node, 'option needs an explicit value independent of its translated label');
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(missing, []);
});

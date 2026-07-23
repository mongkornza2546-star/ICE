import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const servicePath = new URL('../src/features/admin-reference-settings/adminReferenceSettingsService.ts', import.meta.url);
const editorPath = new URL('../src/features/admin-reference-settings/components/IceTypeImageEditor.tsx', import.meta.url);
const cssPath = new URL('../src/index.css', import.meta.url);

test('saving ice type metadata reloads the complete row including image_path', async () => {
  const service = await readFile(servicePath, 'utf8');

  assert.match(service, /const savedId = \(response\.data as \{ id\?: string \} \| null\)\?\.id/);
  assert.match(service, /\.from\('ice_types'\)[\s\S]*?\.select\(ICE_TYPE_FIELDS\)[\s\S]*?\.eq\('id', savedId\)/);
});

test('saving an ice type image path uses the authorized RPC instead of a direct table update', async () => {
  const service = await readFile(servicePath, 'utf8');

  assert.match(service, /\.rpc\('update_ice_type_image_path', \{[\s\S]*?p_ice_type_id: iceTypeId,[\s\S]*?p_image_path: imagePath,/);
  assert.doesNotMatch(service, /\.from\('ice_types'\)[\s\S]{0,240}\.update\(\{ image_path: imagePath \}\)/);
});

test('replacing an ice type image reports a failed old-file cleanup', async () => {
  const editor = await readFile(editorPath, 'utf8');

  assert.match(editor, /removeError = true/);
  assert.match(editor, /อัปเดตรูปสินค้าแล้ว แต่ลบไฟล์เก่าไม่สำเร็จ/);
});

test('ice type image preview has desktop and responsive styles', async () => {
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /\.reference-shop-preview, \.reference-iceType-preview/);
  assert.match(css, /\.reference-iceType-preview__image, \.reference-iceType-preview__placeholder \{ width: 100%; height: 220px; \}/);
  assert.match(css, /\.shop-image-editor, \.iceType-image-editor/);
});

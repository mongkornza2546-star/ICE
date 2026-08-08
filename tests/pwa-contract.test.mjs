import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readProjectAsset = (path) => readFile(new URL(`../${path}`, import.meta.url));

function readPngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test('PWA manifest has installable icons, screenshots, and standalone metadata', async () => {
  const config = await readProjectFile('vite.config.ts');

  assert.match(config, /registerType: 'prompt'/);
  assert.match(config, /id: '\/'/);
  assert.match(config, /display: 'standalone'/);
  assert.match(config, /pwa-icon-192\.png/);
  assert.match(config, /pwa-icon-512\.png/);
  assert.match(config, /pwa-icon-maskable-512\.png/);
  assert.match(config, /purpose: 'maskable'/);
  assert.match(config, /form_factor: 'narrow'/);
  assert.match(config, /form_factor: 'wide'/);
  assert.match(config, /navigateFallback: '\/index\.html'/);
});

test('PWA lifecycle UI covers install, update, and offline states', async () => {
  const [component, html] = await Promise.all([
    readProjectFile('src/PwaUpdatePrompt.tsx'),
    readProjectFile('index.html'),
  ]);

  assert.match(component, /beforeinstallprompt/);
  assert.match(component, /appinstalled/);
  assert.match(component, /onNeedRefresh/);
  assert.match(component, /onOfflineReady/);
  assert.match(component, /window\.addEventListener\('offline'/);
  assert.match(component, /กำลังใช้งานแบบออฟไลน์/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.doesNotMatch(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
});

test('PWA screenshots are genuine PNG files with the declared dimensions', async () => {
  const [mobile, wide] = await Promise.all([
    readProjectAsset('public/pwa-screenshot-mobile.png'),
    readProjectAsset('public/pwa-screenshot-wide.png'),
  ]);

  assert.deepEqual(readPngDimensions(mobile), { width: 426, height: 848 });
  assert.deepEqual(readPngDimensions(wide), { width: 1440, height: 1000 });
});

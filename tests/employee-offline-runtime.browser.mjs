import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';

const build = '/private/tmp/ice-offline-browser-build';
const screenshots = new URL('../audit/employee-performance/pos-network-diagnosis-2026-10-29/browser/', import.meta.url);
await mkdir(screenshots, { recursive: true });
const remote = new Map(); const evidence = new Map(); const received = [];
let loseReply = false;
let networkAvailable = true;
let businessAvailable = true;
const server = createServer(async (req, res) => {
  try {
    if (!networkAvailable) { req.socket.destroy(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (!businessAvailable) { req.socket.destroy(); return; }
      let bytes = []; for await (const b of req) bytes.push(b); const body = Buffer.concat(bytes);
      if (url.pathname.startsWith('/api/evidence/')) {
        const id = url.pathname.split('/').at(-1); evidence.set(id, body.toString());
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: `evidence/${id}.png` })); return;
      }
      const command = JSON.parse(body); received.push(command);
      if (!remote.has(command.id)) {
        remote.set(command.id, { status: 'applied', result: command.type === 'delivery' ? { charge_id: `server-${command.id}`, delivery_event_id: `delivery-${command.id}` } : command.type === 'collection_payment' ? { receipt_number: 'RC-TEST-001', allocated_amount: 30 } : { ok: true } });
      }
      if (loseReply) { req.socket.destroy(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(remote.get(command.id))); return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (name.includes('..')) { res.writeHead(403).end(); return; }
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.setHeader('content-type', mime[path.extname(name)] ?? 'application/octet-stream');
    res.end(await readFile(path.join(build, name)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://localhost:${server.address().port}`;
try {
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    remote.clear(); evidence.clear(); received.length = 0;
    const profile = await mkdtemp('/private/tmp/ice-offline-browser-profile-');
    const context = await browserType.launchPersistentContext(profile, { headless: true, viewport: { width: 390, height: 844 }, isMobile: name !== 'webkit', deviceScaleFactor: 2 });
    try {
      let page = await context.newPage(); const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(url);
      await page.waitForFunction(() => Boolean(window.offlineTest));
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');
      await page.reload();
      await page.waitForFunction(browser => Boolean(window.offlineTest && (browser === 'webkit' || navigator.serviceWorker.controller)), name);
      await page.getByRole('button', { name: 'เตรียมงานทดสอบ' }).click();
      await page.waitForFunction(async () => Boolean((await window.offlineTest.state()).snapshot));
      assert.deepEqual(await page.evaluate(() => window.offlineTest.verifyOnlineCoordination()), {
        pendingAfterReopen: true, installedWhilePending: false, otherWriteBlocked: true, staleInstalled: false, freshInstalled: true,
      });
      console.log(`PASS ${name}: unresolved online write survives IDB reopen, original retry releases it, stale preparation rejected`);
      if (name === 'webkit') {
        const shellCached = await page.evaluate(async () => {
          if (!navigator.serviceWorker.controller) return false;
          for (const key of await caches.keys()) if ((await (await caches.open(key)).keys()).some(r => r.url.includes('/index.html'))) return true;
          return false;
        });
        // Playwright WebKit loses CacheStorage entries on reload (#41618).
        // Keep this an explicit missing acceptance gate, never count it as a pass.
        if (!shellCached) {
          console.log('BLOCKED WebKit offline shell: service-worker control or CacheStorage did not survive reload (https://github.com/microsoft/playwright/issues/41618). Static shell remains reachable for the independent real-IDB tests.');
          assert.ok(!process.argv.includes('--require-webkit-shell'), 'WebKit offline shell acceptance is blocked');
          businessAvailable = false;
        } else networkAvailable = false;
      }
      else await context.setOffline(true);
      await page.reload().catch(async e => { console.error('Offline reload', name, errors); throw e; });
      await page.waitForFunction(() => Boolean(window.offlineTest));
      assert.equal(await page.evaluate(async () => { try { await fetch('/api/probe', { method: 'POST' }); return true; } catch { return false; } }), false);
      await page.getByRole('button', { name: 'เบิก 5 ถุง' }).click();
      await page.waitForFunction(async () => (await window.offlineTest.state()).commands.length === 1);
      await page.getByRole('button', { name: 'ส่ง 2 ถุง' }).click();
      await page.waitForFunction(async () => (await window.offlineTest.state()).commands.length === 2);
      await page.getByRole('button', { name: 'รับโอน 30 บาท' }).click();
      await page.waitForFunction(async () => (await window.offlineTest.state()).commands.length === 3);
      const before = await page.evaluate(() => window.offlineTest.state());
      assert.equal(before.snapshot.stocks.round.holding_location.balances[0].quantity, 13);
      assert.equal(before.snapshot.aggregate.ice, 28);
      assert.equal(before.snapshot.collection.queue[0].outstanding_amount, 20);
      assert.equal(remote.size, 0);
      await page.locator('summary').click();
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-offline.png`, screenshots)), fullPage: true });
      await page.close(); page = await context.newPage();
      await page.goto(url); await page.waitForFunction(() => Boolean(window.offlineTest));
      const restored = await page.evaluate(() => window.offlineTest.state());
      assert.deepEqual(restored.commands.map(c => c.id), before.commands.map(c => c.id));
      assert.equal((await page.evaluate(() => window.offlineTest.evidence()))[0].text, 'proof-on-device');
      assert.deepEqual(await page.evaluate(() => window.offlineTest.otherOwner()), { work: undefined, commands: [] });
      console.log(`PASS ${name}: ${name === 'chromium' ? 'SW offline reload, ' : 'business transport offline, '}close/reopen, stock/delivery/partial collection, Blob and owner isolation`);

      networkAvailable = true; businessAvailable = true; await context.setOffline(false); loseReply = true;
      await page.evaluate(() => window.offlineTest.sync());
      assert.equal(remote.size, 1);
      assert.equal((await page.evaluate(() => window.offlineTest.state())).commands[0].status, 'retry_wait');
      loseReply = false;
      await page.reload(); await page.waitForFunction(() => Boolean(window.offlineTest));
      const second = await context.newPage(); await second.goto(url); await second.waitForFunction(() => Boolean(window.offlineTest));
      await Promise.all([page.evaluate(() => window.offlineTest.sync()), second.evaluate(() => window.offlineTest.sync())]);
      const after = await page.evaluate(() => window.offlineTest.state());
      if (after.commands.some(c => c.status !== 'applied')) console.error(name, after.commands.map(c => ({ type: c.type, status: c.status, error: c.error })), [...evidence.keys()]);
      assert.deepEqual(after.commands.map(c => c.status), ['applied', 'applied', 'applied']);
      assert.equal(remote.size, 3);
      assert.ok(received.length >= 4);
      assert.equal(new Set(received.map(c => c.id)).size, 3);
      assert.equal(evidence.size, 1);
      const paid = received.find(c => c.type === 'collection_payment');
      assert.equal(paid.resolved.args.p_allocations[0].charge_id, `server-${before.commands[1].id}`);
      assert.equal(paid.evidencePath, `evidence/${paid.id}.png`);
      assert.equal(after.snapshot.stocks.round.holding_location.balances[0].quantity, 13);
      await page.locator('summary').click();
      await page.getByText('RC-TEST-001', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-confirmed.png`, screenshots)), fullPage: true });
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: lost acknowledgement, two-tab replay, dependency resolution, one receipt, mobile layout`);
      await context.close();
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }

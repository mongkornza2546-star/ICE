import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildTargetPath,
  createManifestRecorder,
  isR2Path,
  migrateCatalogImage,
  parseMigrationArgs,
  readManifestEntries,
  rollbackCatalogImages,
  updateCatalogImagePath,
  verifyCatalogImageThroughApp,
} from '../scripts/migrate-catalog-images-to-r2.mjs';

test('catalog migration is a dry run unless apply or rollback is explicit', () => {
  assert.deepEqual(parseMigrationArgs([]), { mode: 'dry-run', manifestPath: null, help: false });
  assert.deepEqual(parseMigrationArgs(['--apply', '--manifest', 'migration.jsonl']), {
    mode: 'apply', manifestPath: 'migration.jsonl', help: false,
  });
  assert.deepEqual(parseMigrationArgs(['--rollback', 'migration.jsonl']), {
    mode: 'rollback', manifestPath: 'migration.jsonl', help: false,
  });
  assert.throws(() => parseMigrationArgs(['--apply']), /requires --manifest/);
  assert.throws(() => parseMigrationArgs(['--apply', '--rollback', 'migration.jsonl']), /cannot be combined/);
  assert.throws(() => parseMigrationArgs(['--delete-source']), /Unknown option/);
});

test('target paths are deterministic, versioned by content, and recognized as R2 paths', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const first = buildTargetPath('shops', 'shop-1', 'old/photo.JPG', bytes, 'image/jpeg');
  const repeated = buildTargetPath('shops', 'shop-1', 'old/photo.JPG', bytes, 'image/jpeg');
  const changed = buildTargetPath('shops', 'shop-1', 'old/photo.JPG', new Uint8Array([1, 2, 4]), 'image/jpeg');

  assert.equal(first, repeated);
  assert.notEqual(first, changed);
  assert.match(first, /^shops\/shop-1\/r2\/migrated-[a-f0-9]{64}\.jpg$/);
  assert.equal(isR2Path(first), true);
  assert.equal(isR2Path('shops/shop-1/legacy.jpg'), false);
});

function migrationFixture({ verifiedLength = 3 } = {}) {
  const events = [];
  const storage = {
    download: async (path) => {
      events.push(`download:${path}`);
      return { data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), error: null };
    },
  };
  const updateQuery = {
    eq(column, value) {
      events.push(`eq:${column}:${value}`);
      return updateQuery;
    },
    async select() {
      events.push('database:update');
      return { data: [{ id: 'shop-1' }], error: null };
    },
  };
  const client = {
    storage: { from: () => storage },
    from: () => ({
      update: ({ image_path: imagePath }) => {
        events.push(`prepare-update:${imagePath}`);
        return updateQuery;
      },
    }),
  };
  const r2 = {
    async send(command) {
      events.push(`r2:${command.constructor.name}`);
      return command.constructor.name === 'HeadObjectCommand'
        ? { ContentLength: verifiedLength }
        : {};
    },
  };
  const verifyAppRead = async (namespace, path) => {
    events.push(`app:verify:${namespace}:${path}`);
  };
  const recordManifest = async (entry) => {
    events.push(`manifest:${entry.status}`);
  };
  return { client, events, r2, recordManifest, verifyAppRead };
}

test('migration verifies the R2 object before changing image_path', async () => {
  const fixture = migrationFixture();
  const source = { table: 'shops', bucket: 'shop-images', pathPrefix: 'shops' };

  const targetPath = await migrateCatalogImage({
    client: fixture.client,
    r2: fixture.r2,
    r2Bucket: 'ice-delivery',
    source,
    row: { id: 'shop-1', image_path: 'legacy/photo.jpg' },
    verifyAppRead: fixture.verifyAppRead,
    recordManifest: fixture.recordManifest,
  });

  assert.match(targetPath, /^shops\/shop-1\/r2\//);
  const headIndex = fixture.events.indexOf('r2:HeadObjectCommand');
  const appReadIndex = fixture.events.findIndex((event) => event.startsWith('app:verify:'));
  const manifestIndex = fixture.events.indexOf('manifest:prepared');
  const updateIndex = fixture.events.indexOf('database:update');
  assert.ok(headIndex < appReadIndex);
  assert.ok(appReadIndex < manifestIndex);
  assert.ok(manifestIndex < updateIndex);
  assert.ok(updateIndex < fixture.events.indexOf('manifest:migrated'));
  assert.deepEqual(fixture.events.filter((event) => event.startsWith('eq:')), [
    'eq:id:shop-1',
    'eq:image_path:legacy/photo.jpg',
  ]);
});

test('migration leaves the database unchanged when R2 verification fails', async () => {
  const fixture = migrationFixture({ verifiedLength: 2 });

  await assert.rejects(() => migrateCatalogImage({
    client: fixture.client,
    r2: fixture.r2,
    r2Bucket: 'ice-delivery',
    source: { table: 'shops', bucket: 'shop-images', pathPrefix: 'shops' },
    row: { id: 'shop-1', image_path: 'legacy/photo.jpg' },
    verifyAppRead: fixture.verifyAppRead,
    recordManifest: fixture.recordManifest,
  }), /R2 verification failed/);

  assert.equal(fixture.events.includes('database:update'), false);
});

test('migration leaves the database unchanged when the app read path fails', async () => {
  const fixture = migrationFixture();

  await assert.rejects(() => migrateCatalogImage({
    client: fixture.client,
    r2: fixture.r2,
    r2Bucket: 'ice-delivery',
    source: { table: 'shops', bucket: 'shop-images', pathPrefix: 'shops' },
    row: { id: 'shop-1', image_path: 'legacy/photo.jpg' },
    verifyAppRead: async () => { throw new Error('signing unavailable'); },
    recordManifest: fixture.recordManifest,
  }), /signing unavailable/);

  assert.equal(fixture.events.includes('database:update'), false);
});

test('application verification signs through the Edge Function and reads the R2 object', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ signedUrl: 'https://r2.test/photo?signature=one' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('x', { status: 206 });
  };

  await verifyCatalogImageThroughApp({
    supabaseUrl: 'https://project.supabase.co/',
    apiKey: 'service-role-key',
    accessToken: 'admin-access-token',
    namespace: 'shop-images',
    path: 'shops/shop-1/r2/photo.webp',
    fetchImpl,
  });

  assert.equal(requests[0].url, 'https://project.supabase.co/functions/v1/r2-storage');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer admin-access-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    action: 'sign', namespace: 'shop-images', path: 'shops/shop-1/r2/photo.webp',
  });
  assert.equal(requests[1].options.headers.Range, 'bytes=0-0');
});

test('ice type image paths use the authorized RPC after checking the expected path', async () => {
  const calls = [];
  const query = {
    select(column) { calls.push(['select', column]); return query; },
    eq(column, value) { calls.push(['eq', column, value]); return query; },
    async maybeSingle() {
      return { data: { image_path: 'legacy/ice.jpg' }, error: null };
    },
  };
  const client = {
    from(table) { calls.push(['from', table]); return query; },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      return { data: { image_path: 'ice_types/ice-1/r2/ice.jpg' }, error: null };
    },
  };

  const updated = await updateCatalogImagePath({
    client,
    table: 'ice_types',
    id: 'ice-1',
    expectedPath: 'legacy/ice.jpg',
    nextPath: 'ice_types/ice-1/r2/ice.jpg',
  });

  assert.equal(updated, true);
  assert.deepEqual(calls.at(-1), ['rpc', 'update_ice_type_image_path', {
    p_ice_type_id: 'ice-1',
    p_image_path: 'ice_types/ice-1/r2/ice.jpg',
  }]);
});

test('ice type image RPC is skipped when the expected path no longer matches', async () => {
  let rpcCalled = false;
  const query = {
    select() { return query; },
    eq() { return query; },
    async maybeSingle() { return { data: { image_path: 'newer/ice.jpg' }, error: null }; },
  };
  const client = {
    from() { return query; },
    async rpc() { rpcCalled = true; return { data: null, error: null }; },
  };

  assert.equal(await updateCatalogImagePath({
    client,
    table: 'ice_types',
    id: 'ice-1',
    expectedPath: 'legacy/ice.jpg',
    nextPath: 'ice_types/ice-1/r2/ice.jpg',
  }), false);
  assert.equal(rpcCalled, false);
});

test('rollback restores only rows that still point at the migrated path', async () => {
  const updates = [];
  const client = {
    from(table) {
      const query = {
        update(values) {
          updates.push({ table, values, filters: [] });
          return query;
        },
        eq(column, value) {
          updates.at(-1).filters.push([column, value]);
          return query;
        },
        async select() {
          return { data: updates.length === 1 ? [{ id: 'shop-1' }] : [], error: null };
        },
      };
      return query;
    },
  };
  const entries = [
    { status: 'prepared', table: 'shops', id: 'shop-1', sourcePath: 'legacy/one.jpg', targetPath: 'shops/shop-1/r2/one.jpg' },
    { status: 'migrated', table: 'shops', id: 'shop-1', sourcePath: 'legacy/one.jpg', targetPath: 'shops/shop-1/r2/one.jpg' },
    { status: 'prepared', table: 'shops', id: 'shop-2', sourcePath: 'legacy/two.jpg', targetPath: 'shops/shop-2/r2/two.jpg' },
  ];

  const result = await rollbackCatalogImages({ client, entries });

  assert.deepEqual(result, { restored: 1, skipped: 1, failed: 0 });
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].filters, [
    ['id', 'shop-2'],
    ['image_path', 'shops/shop-2/r2/two.jpg'],
  ]);
});

test('manifest is flushed to a permission-restricted JSONL file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-r2-manifest-'));
  const manifestPath = join(directory, 'migration.jsonl');
  try {
    const manifest = await createManifestRecorder(manifestPath);
    await manifest.record({
      status: 'prepared',
      table: 'shops',
      id: 'shop-1',
      sourcePath: 'legacy/photo.jpg',
      targetPath: 'shops/shop-1/r2/photo.jpg',
    });
    await manifest.close();

    const fileStat = await stat(manifestPath);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.match(await readFile(manifestPath, 'utf8'), /"status":"prepared"/);
    const entries = await readManifestEntries(manifestPath);
    assert.equal(entries[0].sourcePath, 'legacy/photo.jpg');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

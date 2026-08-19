import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const PAGE_SIZE = 500;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const catalogSources = [
  { table: 'shops', bucket: 'shop-images', pathPrefix: 'shops' },
  { table: 'ice_types', bucket: 'ice-type-images', pathPrefix: 'ice_types' },
];

export function isR2Path(path) {
  return path.startsWith('r2/') || path.includes('/r2/');
}

export function parseMigrationArgs(args) {
  const options = { mode: 'dry-run', manifestPath: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      if (options.mode === 'rollback') throw new Error('--apply and --rollback cannot be combined');
      options.mode = 'apply';
    }
    else if (arg === '--manifest' || arg === '--rollback') {
      const manifestPath = args[index + 1];
      if (!manifestPath || manifestPath.startsWith('--')) throw new Error(`${arg} requires a file path`);
      options.manifestPath = manifestPath;
      if (arg === '--rollback') {
        if (options.mode === 'apply') throw new Error('--apply and --rollback cannot be combined');
        options.mode = 'rollback';
      }
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && options.mode === 'apply' && !options.manifestPath) {
    throw new Error('--apply requires --manifest <path>');
  }
  return options;
}

function extensionFor(sourcePath, contentType) {
  const byType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  if (byType[contentType]) return byType[contentType];
  const matched = sourcePath.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return matched?.[1] ?? 'bin';
}

function contentTypeFor(sourcePath, contentType) {
  if (contentType) return contentType;
  const extension = extensionFor(sourcePath, '');
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  }[extension] ?? 'application/octet-stream';
}

export function buildTargetPath(pathPrefix, id, sourcePath, bytes, contentType = '') {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const extension = extensionFor(sourcePath, contentType);
  return `${pathPrefix}/${id}/r2/migrated-${digest}.${extension}`;
}

async function loadCandidates(client, source) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(source.table)
      .select('id, image_path')
      .not('image_path', 'is', null)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Load ${source.table} failed: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows.filter((row) => row.image_path && !isR2Path(row.image_path));
}

export async function verifyCatalogImageThroughApp({
  supabaseUrl,
  apiKey,
  accessToken,
  namespace,
  path,
  fetchImpl = fetch,
}) {
  const signResponse = await fetchImpl(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/r2-storage`, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'sign', namespace, path }),
  });
  const payload = await signResponse.json().catch(() => null);
  if (!signResponse.ok || typeof payload?.signedUrl !== 'string') {
    throw new Error(`Application signing failed: ${payload?.error ?? signResponse.status}`);
  }

  const imageResponse = await fetchImpl(payload.signedUrl, { headers: { Range: 'bytes=0-0' } });
  if (!imageResponse.ok) {
    await imageResponse.body?.cancel().catch(() => undefined);
    throw new Error(`Application image read failed: HTTP ${imageResponse.status}`);
  }
  await imageResponse.body?.cancel().catch(() => undefined);
}

export async function migrateCatalogImage({
  client,
  r2,
  r2Bucket,
  source,
  row,
  verifyAppRead,
  recordManifest,
}) {
  const sourcePath = row.image_path;
  const storage = client.storage.from(source.bucket);
  const { data: blob, error: downloadError } = await storage.download(sourcePath);
  if (downloadError || !blob) {
    throw new Error(`Download failed: ${downloadError?.message ?? 'empty response'}`);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const contentType = contentTypeFor(sourcePath, blob.type);
  const targetPath = buildTargetPath(source.pathPrefix, row.id, sourcePath, bytes, contentType);
  const key = `${source.bucket}/${targetPath}`;

  await r2.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    CacheControl: CACHE_CONTROL,
  }));

  const head = await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
  if (head.ContentLength !== bytes.byteLength) {
    throw new Error(`R2 verification failed: expected ${bytes.byteLength} bytes, got ${head.ContentLength ?? 'unknown'}`);
  }

  await verifyAppRead(source.bucket, targetPath);
  const manifestEntry = {
    table: source.table,
    id: row.id,
    sourcePath,
    targetPath,
  };
  await recordManifest({ ...manifestEntry, status: 'prepared' });

  const updated = await updateCatalogImagePath({
    client,
    table: source.table,
    id: row.id,
    expectedPath: sourcePath,
    nextPath: targetPath,
  });
  if (!updated) {
    throw new Error('Database update skipped because image_path changed during migration');
  }

  await recordManifest({ ...manifestEntry, status: 'migrated' });
  return targetPath;
}

export async function updateCatalogImagePath({ client, table, id, expectedPath, nextPath }) {
  if (table === 'ice_types') {
    const { data: current, error: readError } = await client
      .from(table)
      .select('image_path')
      .eq('id', id)
      .maybeSingle();
    if (readError) throw new Error(`Database read failed: ${readError.message}`);
    if (current?.image_path !== expectedPath) return false;

    const { data: updated, error: updateError } = await client.rpc('update_ice_type_image_path', {
      p_ice_type_id: id,
      p_image_path: nextPath,
    });
    if (updateError) throw new Error(`Database update failed: ${updateError.message}`);
    return updated?.image_path === nextPath;
  }

  const { data: updatedRows, error: updateError } = await client
    .from(table)
    .update({ image_path: nextPath })
    .eq('id', id)
    .eq('image_path', expectedPath)
    .select('id');
  if (updateError) throw new Error(`Database update failed: ${updateError.message}`);
  return updatedRows?.length === 1;
}

export async function createManifestRecorder(manifestPath) {
  const resolvedPath = resolve(manifestPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const handle = await open(resolvedPath, 'a', 0o600);
  await chmod(resolvedPath, 0o600);
  return {
    path: resolvedPath,
    async record(entry) {
      await handle.appendFile(`${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`);
      await handle.sync();
    },
    async close() {
      await handle.close();
    },
  };
}

export async function readManifestEntries(manifestPath) {
  const content = await readFile(resolve(manifestPath), 'utf8');
  return content.split('\n').filter(Boolean).map((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on manifest line ${index + 1}`);
    }
    if (!catalogSources.some((source) => source.table === entry.table)
      || typeof entry.id !== 'string'
      || typeof entry.sourcePath !== 'string'
      || typeof entry.targetPath !== 'string') {
      throw new Error(`Invalid migration entry on manifest line ${index + 1}`);
    }
    return entry;
  });
}

export async function rollbackCatalogImages({ client, entries }) {
  const mappings = [];
  const seen = new Set();
  for (const entry of [...entries].reverse()) {
    const key = `${entry.table}:${entry.id}:${entry.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push(entry);
  }

  const result = { restored: 0, skipped: 0, failed: 0 };
  for (const entry of mappings) {
    try {
      const restored = await updateCatalogImagePath({
        client,
        table: entry.table,
        id: entry.id,
        expectedPath: entry.targetPath,
        nextPath: entry.sourcePath,
      });
      if (restored) result.restored += 1;
      else result.skipped += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running this script.`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  npm run storage:migrate-catalog-images
  npm run storage:migrate-catalog-images -- --apply --manifest <path>
  npm run storage:migrate-catalog-images -- --rollback <path>

Without --apply, the script only lists how many legacy Supabase images would move.
Apply mode verifies R2 and the deployed Edge Function before updating image_path.
The manifest and retained Supabase objects support conditional rollback.`);
}

export async function main() {
  const options = parseMigrationArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const supabaseUrl = requiredEnvironment('SUPABASE_URL');
  const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
  const adminAccessToken = requiredEnvironment('SUPABASE_ADMIN_ACCESS_TOKEN');
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${adminAccessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket },
  });

  if (options.mode === 'rollback') {
    const entries = await readManifestEntries(options.manifestPath);
    const result = await rollbackCatalogImages({ client, entries });
    console.log(`Rollback complete: ${result.restored} restored, ${result.skipped} skipped, ${result.failed} failed.`);
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  const sourcesWithCandidates = [];
  for (const source of catalogSources) {
    const candidates = await loadCandidates(client, source);
    sourcesWithCandidates.push({ source, candidates });
    console.log(`${source.table}: ${candidates.length} image(s) waiting to migrate`);
  }

  const candidateCount = sourcesWithCandidates.reduce((total, item) => total + item.candidates.length, 0);
  if (options.mode === 'dry-run') {
    console.log(`Dry run complete. ${candidateCount} image(s) would move; no data was changed.`);
    return;
  }
  if (candidateCount === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  const accountId = requiredEnvironment('R2_ACCOUNT_ID');
  const accessKeyId = requiredEnvironment('R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnvironment('R2_SECRET_ACCESS_KEY');
  const r2Bucket = requiredEnvironment('R2_BUCKET_NAME');
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const manifest = await createManifestRecorder(options.manifestPath);
  console.log(`Rollback manifest: ${manifest.path}`);
  const verifyAppRead = (namespace, path) => verifyCatalogImageThroughApp({
    supabaseUrl,
    apiKey: anonKey,
    accessToken: adminAccessToken,
    namespace,
    path,
  });

  let migrated = 0;
  let failed = 0;
  try {
    for (const { source, candidates } of sourcesWithCandidates) {
      for (const row of candidates) {
        try {
          const targetPath = await migrateCatalogImage({
            client,
            r2,
            r2Bucket,
            source,
            row,
            verifyAppRead,
            recordManifest: manifest.record,
          });
          migrated += 1;
          console.log(`MIGRATED ${source.table}/${row.id}: ${row.image_path} -> ${targetPath}`);
        } catch (error) {
          failed += 1;
          console.error(`FAILED ${source.table}/${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    await manifest.close();
  }

  console.log(`Migration complete: ${migrated} migrated, ${failed} failed. Supabase originals were retained.`);
  if (failed > 0) process.exitCode = 1;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

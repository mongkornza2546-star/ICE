import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;

async function issueNumber(documentType, periodMonth) {
  const { stdout } = await execFileAsync('psql', [
    databaseUrl,
    '-AtX',
    '-v', 'ON_ERROR_STOP=1',
    '-c', `select public.next_sales_document_number('${documentType}', date '${periodMonth}')`,
  ]);
  return stdout.trim();
}

test('real PostgreSQL serializes monthly INV and REC counters across connections', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to run real PostgreSQL concurrency verification',
}, async () => {
  const periodMonth = '2099-12-01';
  await execFileAsync('psql', [
    databaseUrl,
    '-AtX',
    '-v', 'ON_ERROR_STOP=1',
    '-c', `delete from public.document_counters where period_month = date '${periodMonth}'`,
  ]);

  const [invNumbers, recNumbers] = await Promise.all([
    Promise.all(Array.from({ length: 8 }, () => issueNumber('INV', periodMonth))),
    Promise.all(Array.from({ length: 8 }, () => issueNumber('REC', periodMonth))),
  ]);

  assert.equal(new Set(invNumbers).size, invNumbers.length);
  assert.equal(new Set(recNumbers).size, recNumbers.length);
  assert.ok(invNumbers.every((number) => /^INV9912-\d{5}$/.test(number)));
  assert.ok(recNumbers.every((number) => /^REC9912-\d{5}$/.test(number)));
  assert.deepEqual(
    invNumbers.map((number) => number.slice(-5)).sort(),
    ['00001', '00002', '00003', '00004', '00005', '00006', '00007', '00008'],
  );
  assert.deepEqual(
    recNumbers.map((number) => number.slice(-5)).sort(),
    ['00001', '00002', '00003', '00004', '00005', '00006', '00007', '00008'],
  );
});

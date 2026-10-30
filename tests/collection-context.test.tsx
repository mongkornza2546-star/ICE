import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import {
  COLLECTION_PROFILE_REFRESH_EVENT,
  ensureCurrentCollectionContext,
  invalidateCurrentCollectionContext,
} from '../src/lib/collectionContext';
import { loadCurrentCollectionQueue } from '../src/lib/collectionQueue';

describe('automatic collection context', () => {
  beforeEach(() => {
    invalidateCurrentCollectionContext();
    supabaseMock.rpc.mockReset();
  });

  it('keeps outstanding shops visible on a closed date without opening a collection context', async () => {
    const queue = [{ shop_id: 'shop-1', outstanding_amount: 120, charges: [] }];
    supabaseMock.rpc.mockImplementation(async (name: string) => name === 'get_daily_shop_collection_queue_v2'
      ? { data: { collection_run_id: null, status: 'closed', queue }, error: null }
      : { data: null, error: new Error('The selected business date is already closed') });

    expect(await loadCurrentCollectionQueue('2026-10-21')).toEqual({ runId: null, isClosed: true, canRecordPayment: false, queue });
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1);
  });

  it('loads the unified shop queue with its current payment context', async () => {
    const queue = [{ shop_id: 'shop-1', collection_scope: 'shop', outstanding_amount: 1920, charges: [] }];
    supabaseMock.rpc.mockResolvedValueOnce({
      data: { collection_run_id: 'run-1', status: 'open', queue }, error: null,
    });
    expect(await loadCurrentCollectionQueue('2026-10-12')).toEqual({ runId: 'run-1', isClosed: false, canRecordPayment: undefined, queue });
    expect(supabaseMock.rpc).toHaveBeenLastCalledWith('get_daily_shop_collection_queue_v2', { p_service_date: '2026-10-12' });
  });

  it.each([true, false])('preserves explicit server payment permission (%s)', async allowed => {
    supabaseMock.rpc.mockResolvedValue({ data: { collection_run_id: 'run-1', status: 'open', queue: [], can_record_payment: allowed }, error: null });
    expect((await loadCurrentCollectionQueue('2026-10-30')).canRecordPayment).toBe(allowed);
  });

  it('falls back to the legacy queue only when the new RPC is not deployed', async () => {
    const queue = [{ queue_key: 'event:context-1', shop_id: 'shop-1', outstanding_amount: 120 }];
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'RPC missing' } })
      .mockResolvedValueOnce({ data: { collection_run_id: 'run-1', status: 'open', queue }, error: null });
    expect((await loadCurrentCollectionQueue('2026-10-27')).queue).toEqual(queue);
    expect(supabaseMock.rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_daily_shop_collection_queue_v2', 'get_daily_shop_collection_queue',
    ]);
  });

  it.each(['42501', 'P0001', '08006'])('does not mask a queue error (%s) with a legacy fallback', async code => {
    const error = { code, message: 'Cannot load queue' };
    supabaseMock.rpc.mockResolvedValue({ data: null, error });
    await expect(loadCurrentCollectionQueue('2026-10-27')).rejects.toEqual(error);
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent ensures and caches the current service date', async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: { collection_run_id: 'run-1', service_date: '2026-08-26', status: 'open' },
      error: null,
    });

    const [first, second] = await Promise.all([
      ensureCurrentCollectionContext('2026-08-26'),
      ensureCurrentCollectionContext('2026-08-26'),
    ]);
    const cached = await ensureCurrentCollectionContext('2026-08-26');

    expect(first).toEqual(second);
    expect(cached.collection_run_id).toBe('run-1');
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1);
  });

  it('drops stale context when the business date changes', async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: { collection_run_id: 'run-1', service_date: '2026-08-26', status: 'open' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { collection_run_id: 'run-2', service_date: '2026-08-27', status: 'open' },
        error: null,
      });

    await ensureCurrentCollectionContext('2026-08-26');
    const next = await ensureCurrentCollectionContext('2026-08-27');

    expect(next.collection_run_id).toBe('run-2');
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(2);
  });

  it('requests an immediate profile refresh after authorization failure', async () => {
    const onRefresh = vi.fn();
    window.addEventListener(COLLECTION_PROFILE_REFRESH_EVENT, onRefresh);
    supabaseMock.rpc.mockResolvedValue({ data: null, error: new Error('cannot collect') });

    await expect(ensureCurrentCollectionContext('2026-08-26')).rejects.toThrow('cannot collect');

    expect(onRefresh).toHaveBeenCalledTimes(1);
    window.removeEventListener(COLLECTION_PROFILE_REFRESH_EVENT, onRefresh);
  });
  it('retains a closed admin context only with the explicit write capability', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: { collection_run_id: 'closed-run',
      service_date: '2026-10-21', status: 'closed', can_record_payment: true }, error: null });
    expect((await ensureCurrentCollectionContext('2026-10-21')).status).toBe('closed');
    invalidateCurrentCollectionContext();
    supabaseMock.rpc.mockResolvedValue({ data: { collection_run_id: 'closed-run',
      service_date: '2026-10-21', status: 'closed' }, error: null });
    await expect(ensureCurrentCollectionContext('2026-10-21')).rejects.toThrow();
  });

});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import {
  COLLECTION_PROFILE_REFRESH_EVENT,
  ensureCurrentCollectionContext,
  invalidateCurrentCollectionContext,
} from '../src/lib/collectionContext';

describe('automatic collection context', () => {
  beforeEach(() => {
    invalidateCurrentCollectionContext();
    supabaseMock.rpc.mockReset();
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
});

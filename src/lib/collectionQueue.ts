import type { QueueShop } from '../features/financial-operations/types';
import { ensureCurrentCollectionContext, invalidateCurrentCollectionContext } from './collectionContext';
import { supabase } from './supabase';

export interface CurrentCollectionQueue {
  runId: string | null;
  queue: QueueShop[];
}

export async function loadCurrentCollectionQueue(serviceDate: string): Promise<CurrentCollectionQueue> {
  if (!supabase) return { runId: null, queue: [] };
  const context = await ensureCurrentCollectionContext(serviceDate);
  const runId = context.collection_run_id;
  if (!runId) return { runId: null, queue: [] };

  const response = await supabase.rpc('get_collection_run_queue', {
    p_collection_run_id: runId,
  });
  if (response.error) {
    invalidateCurrentCollectionContext(true);
    throw response.error;
  }
  return { runId, queue: (response.data ?? []) as QueueShop[] };
}

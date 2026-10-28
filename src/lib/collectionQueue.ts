import type { QueueShop } from '../features/financial-operations/types';
import { invalidateCurrentCollectionContext } from './collectionContext';
import { supabase } from './supabase';

export interface CurrentCollectionQueue {
  runId: string | null;
  isClosed: boolean;
  canRecordPayment?: boolean;
  queue: QueueShop[];
}

export async function loadCurrentCollectionQueue(serviceDate: string): Promise<CurrentCollectionQueue> {
  if (!supabase) return { runId: null, isClosed: false, queue: [] };
  let response = await supabase.rpc('get_daily_shop_collection_queue_v2', {
    p_service_date: serviceDate,
  });
  // A frontend can arrive before its migration. Only a missing RPC permits
  // legacy rows; authorization, date and transport failures must still surface.
  if (response.error?.code === 'PGRST202') {
    response = await supabase.rpc('get_daily_shop_collection_queue', {
      p_service_date: serviceDate,
    });
  }
  if (response.error) {
    invalidateCurrentCollectionContext(true);
    throw response.error;
  }
  return {
    runId: response.data.collection_run_id,
    isClosed: response.data.status === 'closed',
    canRecordPayment: response.data.can_record_payment === true,
    queue: (response.data.queue ?? []) as QueueShop[],
  };
}

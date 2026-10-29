import type { WorkSnapshot } from '../../src/offline/runtime/types';
const owner = '10000000-0000-4000-8000-000000000001';
const day = '2026-10-29';
export function offlineSnapshot(): WorkSnapshot {
  return { version: 1, ownerId: owner, serviceDate: day, preparedAt: '2026-10-29T01:00:00Z', validUntil: '2026-10-29T17:00:00Z',
    profile: { id: owner, code: 'EMP', display_name: 'Employee', phone: null, role: 'courier', is_active: true, can_collect_shop_payments: true },
    rounds: [{ id: 'round', service_date: day, name: 'round', status: 'open', opened_at: '' }], iceTypes: [], cards: { round: [] }, collection: { runId: 'run', isClosed: false, queue: [] },
    aggregate: { ice: 30 }, stocks: { round: { round_id: 'round', service_date: day, withdrawn_balances: [],
      truck_location: { id: 'truck', code: 'T', name: 'truck', balances: [{ ice_type_id: 'ice', ice_type_name: 'ice', unit: 'bag', quantity: 20 }] },
      holding_location: { id: 'holding', code: 'H', name: 'holding', balances: [{ ice_type_id: 'ice', ice_type_name: 'ice', unit: 'bag', quantity: 10 }] } } },
    contexts: { stop: { round_id: 'round', round_stop_id: 'stop', service_date: day, shop: { id: 'shop', code: 'S', name: 'shop', building_name: 'B', floor_or_zone: '1', image_path: null },
      stock_source: { id: 'holding', code: 'H', name: 'holding', kind: 'team' }, payment_profile: null,
      items: [{ ice_type_id: 'ice', code: 'I', name: 'ice', unit: 'bag', image_path: null, stock_quantity: 10, unit_price: 25, price_source: 'standard', price_source_id: 'price' }] } } };
}

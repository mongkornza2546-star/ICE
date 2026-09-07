import { expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ tables: {
  shops: [
    { id: 'regular', code: 'S01', name: 'Regular', status: 'active', event_job_id: null },
    ...Array.from({ length: 300 }, (_, i) => ({ id: `event-${i}`, code: `EV-${i}`, name: `บูธ ${i}`, status: 'active', event_job_id: 'event-1' })),
  ],
  shop_payment_profiles: [{ shop_id: 'regular' }],
  ice_types: [{ id: 'ice', is_active: true }],
  ice_type_prices: [{ ice_type_id: 'ice', valid_from: '2026-09-07', valid_to: null, is_active: true }],
  shop_ice_type_prices: [],
} as Record<string, Record<string, unknown>[]> }));

vi.mock('../src/lib/supabase', () => ({ supabase: {
  from(table: string) {
    let rows = database.tables[table];
    const query = {
      select() { return query; },
      eq(key: string, value: unknown) { rows = rows.filter(row => row[key] === value); return query; },
      is(key: string, value: unknown) { rows = rows.filter(row => row[key] === value); return query; },
      order() { return query; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
    };
    return query;
  },
} }));

import { loadPOSReadinessReport } from '../src/features/admin-reference-settings/adminReferenceSettingsService';

it('does not report 300 event booths as regular shops missing payment profiles', async () => {
  const report = await loadPOSReadinessReport('2026-09-07');
  expect(report.total_active_shops).toBe(1);
  expect(report.shops_ready_count).toBe(1);
  expect(report.shops_missing_payment_profile).toBe(0);
  expect(report.items.map(item => item.shop_id)).toEqual(['regular']);
});

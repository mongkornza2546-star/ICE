import type { SupabaseClient } from '@supabase/supabase-js';
import type { BuildingOption, BuildingZoneOption, ShopSetting } from '../../types/app';
import type { DirectoryPriceSetting, ShopDirectoryPaymentProfile } from './exportShopDirectory';

const EXPORT_PAGE_SIZE = 500;
const EXPORT_ID_BATCH_SIZE = 50;
const EXPORT_RETRY_MESSAGE = 'ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองใหม่';

interface ExportRowWithId {
  id: string;
}

interface ExportQueryPage<T> {
  data: T[] | null;
  error: { message: string } | null;
  count: number | null;
}

interface ShopDirectoryPaymentProfileRow extends ShopDirectoryPaymentProfile, ExportRowWithId {}
interface DirectoryPriceRow extends DirectoryPriceSetting, ExportRowWithId {}

export interface ShopDirectoryExportData {
  buildings: BuildingOption[];
  zones: BuildingZoneOption[];
  paymentProfiles: ShopDirectoryPaymentProfile[];
  standardPrices: DirectoryPriceSetting[];
  shopPrices: DirectoryPriceSetting[];
}

function batches<T>(values: T[]) {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += EXPORT_ID_BATCH_SIZE) {
    result.push(values.slice(offset, offset + EXPORT_ID_BATCH_SIZE));
  }
  return result;
}

async function loadCompleteRows<T extends ExportRowWithId>(
  loadPage: (from: number, to: number) => Promise<ExportQueryPage<T>>,
) {
  const rows: T[] = [];
  const seenIds = new Set<string>();
  let expectedCount: number | null = null;

  do {
    const page = await loadPage(rows.length, rows.length + EXPORT_PAGE_SIZE - 1);
    if (page.error) throw new Error(page.error.message);
    if (page.count == null || !Number.isInteger(page.count) || page.count < 0) {
      throw new Error(EXPORT_RETRY_MESSAGE);
    }
    if (expectedCount == null) expectedCount = page.count;
    else if (page.count !== expectedCount) throw new Error(EXPORT_RETRY_MESSAGE);

    const pageRows = page.data ?? [];
    if (pageRows.length === 0 && rows.length < expectedCount) throw new Error(EXPORT_RETRY_MESSAGE);
    if (pageRows.length > expectedCount - rows.length) throw new Error(EXPORT_RETRY_MESSAGE);
    pageRows.forEach((row) => {
      if (seenIds.has(row.id)) throw new Error(EXPORT_RETRY_MESSAGE);
      seenIds.add(row.id);
      rows.push(row);
    });
  } while (rows.length < (expectedCount ?? 0));

  return rows;
}

async function loadBatchedRows<T extends ExportRowWithId>(
  ids: string[],
  loadBatch: (ids: string[]) => Promise<T[]>,
) {
  const rows = await Promise.all(batches([...new Set(ids)]).map(loadBatch));
  return rows.flat();
}

export async function loadShopDirectoryExportData(
  client: SupabaseClient,
  shops: ShopSetting[],
  effectiveDate: string,
): Promise<ShopDirectoryExportData> {
  const shopIds = shops.map((shop) => shop.id);
  const buildingIds = shops.map((shop) => shop.building_id);
  const zoneIds = shops.map((shop) => shop.zone_id);

  const [buildings, zones, paymentProfiles, standardPrices, shopPrices] = await Promise.all([
    loadBatchedRows<BuildingOption>(buildingIds, (ids) => loadCompleteRows(async (from, to) => {
      const response = await client
        .from('buildings')
        .select('id, code, name', { count: 'exact' })
        .in('id', ids)
        .order('id')
        .range(from, to);
      return { ...response, data: (response.data ?? []) as BuildingOption[] };
    })),
    loadBatchedRows<BuildingZoneOption>(zoneIds, (ids) => loadCompleteRows(async (from, to) => {
      const response = await client
        .from('building_zones')
        .select('id, building_id, code, name, sort_order, is_active', { count: 'exact' })
        .in('id', ids)
        .order('id')
        .range(from, to);
      return { ...response, data: (response.data ?? []) as BuildingZoneOption[] };
    })),
    loadBatchedRows<ShopDirectoryPaymentProfileRow>(shopIds, (ids) => loadCompleteRows(async (from, to) => {
      const response = await client
        .from('shop_payment_profiles')
        .select('id, shop_id, allowed_payment_terms, default_payment_term, credit_due_rule, credit_days, credit_collection_weekday', { count: 'exact' })
        .in('shop_id', ids)
        .order('id')
        .range(from, to);
      return { ...response, data: (response.data ?? []) as ShopDirectoryPaymentProfileRow[] };
    })),
    loadCompleteRows<DirectoryPriceRow>(async (from, to) => {
      const response = await client
        .from('ice_type_prices')
        .select('id, ice_type_id, unit_price, valid_from, valid_to, is_active', { count: 'exact' })
        .eq('is_active', true)
        .lte('valid_from', effectiveDate)
        .or(`valid_to.is.null,valid_to.gte.${effectiveDate}`)
        .order('id')
        .range(from, to);
      return { ...response, data: (response.data ?? []) as DirectoryPriceRow[] };
    }),
    loadBatchedRows<DirectoryPriceRow>(shopIds, (ids) => loadCompleteRows(async (from, to) => {
      const response = await client
        .from('shop_ice_type_prices')
        .select('id, shop_id, ice_type_id, unit_price, valid_from, valid_to, is_active', { count: 'exact' })
        .in('shop_id', ids)
        .eq('is_active', true)
        .lte('valid_from', effectiveDate)
        .or(`valid_to.is.null,valid_to.gte.${effectiveDate}`)
        .order('id')
        .range(from, to);
      return { ...response, data: (response.data ?? []) as DirectoryPriceRow[] };
    })),
  ]);

  return {
    buildings,
    zones,
    paymentProfiles,
    standardPrices: standardPrices.map((price) => ({ ...price, unit_price: Number(price.unit_price) })),
    shopPrices: shopPrices.map((price) => ({ ...price, unit_price: Number(price.unit_price) })),
  };
}

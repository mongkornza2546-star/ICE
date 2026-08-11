import type {
  BuildingOption,
  BuildingZoneOption,
  CreditDueRule,
  IceTypeOption,
  PaymentTerm,
  ShopSetting,
} from '../../types/app';
import { formatCreditCollectionCycle } from '../../lib/creditCollectionCycle';
import type { Cell } from 'write-excel-file';

export interface ShopDirectoryPaymentProfile {
  shop_id: string;
  allowed_payment_terms: PaymentTerm[];
  default_payment_term: PaymentTerm;
  credit_due_rule: CreditDueRule | null;
  credit_days: number | null;
  credit_collection_weekday: number | null;
}

export interface DirectoryPriceSetting {
  shop_id?: string;
  ice_type_id: string;
  unit_price: number;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
}

interface ExportShopDirectoryOptions {
  shops: ShopSetting[];
  buildings: BuildingOption[];
  zones: BuildingZoneOption[];
  iceTypes: IceTypeOption[];
  paymentProfiles: ShopDirectoryPaymentProfile[];
  standardPrices: DirectoryPriceSetting[];
  shopPrices: DirectoryPriceSetting[];
  effectiveDate: string;
}

const paymentTermLabels: Record<PaymentTerm, string> = {
  immediate: 'จ่ายทันที',
  end_of_day: 'เก็บท้ายวัน',
  credit: 'เครดิต',
};

function safeSpreadsheetText(value: unknown) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function activePrice<T extends DirectoryPriceSetting>(prices: T[], effectiveDate: string) {
  return prices
    .filter((price) => price.is_active
      && price.valid_from <= effectiveDate
      && (price.valid_to == null || price.valid_to >= effectiveDate))
    .sort((left, right) => right.valid_from.localeCompare(left.valid_from))[0];
}

function paymentCondition(profile: ShopDirectoryPaymentProfile | undefined) {
  if (!profile) return 'ยังไม่ได้ตั้งค่า';

  const terms = profile.allowed_payment_terms.map((term) => (
    `${paymentTermLabels[term]}${term === profile.default_payment_term ? ' (ค่าเริ่มต้น)' : ''}`
  ));
  if (profile.allowed_payment_terms.includes('credit')) {
    terms.push(formatCreditCollectionCycle(profile));
  }
  return terms.join(' · ');
}

export async function exportShopDirectory({
  shops,
  buildings,
  zones,
  iceTypes,
  paymentProfiles,
  standardPrices,
  shopPrices,
  effectiveDate,
}: ExportShopDirectoryOptions) {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const sortedIceTypes = [...iceTypes].sort((left, right) => left.code.localeCompare(right.code, 'en', { numeric: true }));
  const headings = [
    'ตึก',
    'ชื่อร้าน',
    'โซน',
    'รหัสร้าน',
    'เงื่อนไขชำระ',
    ...sortedIceTypes.flatMap((iceType) => [
      `${iceType.name} · ราคา (บาท/${iceType.unit})`,
      `${iceType.name} · แหล่งราคา`,
    ]),
  ];
  const headerStyle = {
    value: '',
    type: String,
    fontWeight: 'bold' as const,
    backgroundColor: '#DCE9F8',
    color: '#17365D',
    align: 'center' as const,
    wrap: true,
    borderStyle: 'thin' as const,
    borderColor: '#B8CAE2',
  };
  const bodyBorder = { borderStyle: 'thin' as const, borderColor: '#D9E3F0' };
  const textCell = (value: unknown, wrap = false) => ({
    value: safeSpreadsheetText(value), type: String, wrap, ...bodyBorder,
  });
  const numberCell = (value: number) => ({ value, type: Number, format: '#,##0.00', ...bodyBorder });
  const buildingsById = new Map(buildings.map((building) => [building.id, building]));
  const zonesById = new Map(zones.map((zone) => [zone.id, zone]));
  const profilesByShopId = new Map(paymentProfiles.map((profile) => [profile.shop_id, profile]));

  const sortedShops = [...shops].sort((left, right) => left.code.localeCompare(right.code, 'en', { numeric: true }));
  const rows = sortedShops.map((shop) => {
    const cells: Cell[] = [
      textCell(buildingsById.get(shop.building_id)?.name ?? ''),
      textCell(shop.name, true),
      textCell(zonesById.get(shop.zone_id)?.name ?? shop.floor_or_zone),
      textCell(shop.code),
      textCell(paymentCondition(profilesByShopId.get(shop.id)), true),
    ];

    sortedIceTypes.forEach((iceType) => {
      const specialPrice = activePrice(
        shopPrices.filter((price) => price.shop_id === shop.id && price.ice_type_id === iceType.id),
        effectiveDate,
      );
      const standardPrice = activePrice(
        standardPrices.filter((price) => price.ice_type_id === iceType.id),
        effectiveDate,
      );
      const effectivePrice = specialPrice ?? standardPrice;
      cells.push(effectivePrice ? numberCell(Number(effectivePrice.unit_price)) : textCell(''));
      cells.push(textCell(specialPrice ? 'ราคาพิเศษร้าน' : standardPrice ? 'ราคากลาง' : 'ยังไม่ได้ตั้งราคา'));
    });
    return cells;
  });

  const data = [
    [{ value: 'ข้อมูลร้านค้าและราคาที่ใช้งาน', type: String, fontWeight: 'bold' as const, fontSize: 15, color: '#17365D', span: headings.length }],
    [{ value: `ราคาที่มีผล ณ วันที่ ${effectiveDate}`, type: String, color: '#5B6F89', span: headings.length }],
    headings.map((value) => ({ ...headerStyle, value })),
    ...rows,
  ];

  await writeXlsxFile(data, {
    columns: headings.map((_, index) => ({ width: index === 1 ? 30 : index === 4 ? 34 : index < 5 ? 18 : 22 })),
    fileName: `ข้อมูลร้านค้า-${effectiveDate}.xlsx`,
    sheet: 'ร้านค้า',
    stickyColumnsCount: 5,
    stickyRowsCount: 3,
  });
}

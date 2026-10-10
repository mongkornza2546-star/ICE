import { uiDateTimeFormat } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { withAsyncPublicImageUrls, type PublicImagePathItem } from '../../lib/publicImageUrls';
import { getHybridObjectUrls } from '../../lib/r2Storage';
import type {
  PaymentProfile,
  PaymentReceiptSnapshot,
  QueueShop,
  ReceiptCharge,
  ReceiptItemRow,
} from './types';
import type { PaymentMethod } from '../../types/app';
import { isBoothSameAsName } from '../employee-delivery/utils';

export const USER_AVATAR_BUCKET = 'user-avatars';
export const SHOP_IMAGE_BUCKET = 'shop-images';

export const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

export const receiptDateTime = uiDateTimeFormat({
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

const serviceDateFormat = uiDateTimeFormat({ dateStyle: 'medium' });

export function formatServiceDate(value: string) {
  return serviceDateFormat.format(new Date(`${value}T12:00:00+07:00`));
}

export function formatPaymentReceivedAt(payment: { recorded_at: string; received_date_override?: string | null }) {
  return payment.received_date_override
    ? formatServiceDate(payment.received_date_override)
    : receiptDateTime.format(new Date(payment.recorded_at));
}

export function paymentMethodLabel(method: PaymentMethod) {
  return method === 'cash' ? 'เงินสด' : 'โอนเงิน';
}

export function initials(code: string) {
  return code.replace(/[^A-Za-zก-๙0-9]/g, '').slice(0, 2).toUpperCase() || 'ร';
}

export function isEventCode(code?: string | null): boolean {
  if (!code) return false;
  const upper = code.trim().toUpperCase();
  return upper.startsWith('EV-') || upper.startsWith('EVENT-') || upper.startsWith('SITE-EVENT-');
}

export function formatBoothText(boothNumber?: string | null): string {
  if (!boothNumber || !boothNumber.trim()) return '';
  const trimmed = boothNumber.trim();
  return trimmed.startsWith('บูธ') ? trimmed : `บูธ ${trimmed}`;
}

export function formatCollectionShopIdentity(shop: {
  destination_kind?: 'regular' | 'event';
  shop_code?: string | null;
  shop_name?: string | null;
  event_booth?: string | null;
}) {
  const isEvent = shop.destination_kind === 'event';
  const hasEventCode = isEventCode(shop.shop_code) || (isEvent && !shop.shop_code);

  if (!isEvent) {
    const code = shop.shop_code ?? '—';
    const name = shop.shop_name ?? '';
    return {
      isEvent: false,
      isEventOnly: false,
      title: name ? `${code} · ${name}` : code,
      boothText: '',
      shopName: name,
      avatarText: initials(code),
    };
  }

  const boothText = formatBoothText(shop.event_booth);
  const rawBooth = shop.event_booth?.trim() ?? '';
  const shopName = shop.shop_name?.trim() ?? '';
  const sameAsBooth = isBoothSameAsName(shopName, rawBooth);
  const hasDistinctName = Boolean(shopName && !sameAsBooth);

  const primary = boothText || shopName || 'ไม่ระบุบูธ';
  let title: string;
  if (hasEventCode) {
    title = hasDistinctName && boothText ? `${boothText} · ${shopName}` : primary;
  } else {
    const code = shop.shop_code ?? '—';
    title = shopName ? `${code} · ${shopName}` : code;
  }

  const avatarSource = (hasEventCode ? rawBooth.replace(/^บูธ\s*/, '') || shopName : shop.shop_code) || 'บ';

  return {
    isEvent: true,
    isEventOnly: hasEventCode,
    title,
    boothText: primary,
    shopName: hasDistinctName ? shopName : '',
    avatarText: initials(avatarSource),
  };
}

export function receiptChargesFromRows(rows: ReceiptItemRow[]) {
  const charges = new Map<string | null, ReceiptCharge>();
  for (const row of rows) {
    const chargeNumber = row.charge_number;
    const charge = charges.get(chargeNumber) ?? {
      chargeNumber,
      receivedAmount: Number(row.received_amount),
      items: [],
    };
    charge.items.push({
      name: row.ice_type_name,
      unit: row.ice_type_unit,
      quantity: Number(row.quantity),
      lineTotal: Number(row.line_total),
    });
    charges.set(chargeNumber, charge);
  }
  return [...charges.values()];
}

export function receiptFromSnapshot(snapshot: PaymentReceiptSnapshot) {
  return {
    paymentId: snapshot.payment_id,
    receiptNumber: snapshot.receipt_number,
    shopCode: snapshot.shop_code,
    shopName: snapshot.shop_name,
    method: snapshot.payment_method,
    receivedAmount: Number(snapshot.received_amount),
    allocatedAmount: Number(snapshot.allocated_amount),
    changeAmount: Number(snapshot.change_amount),
    recordedAt: snapshot.recorded_at,
    receivedDate: snapshot.received_date_override ?? null,
    enteredAt: snapshot.entered_at ?? null,
    title: snapshot.document_title ?? 'ใบเสร็จรับเงิน',
    status: snapshot.status ?? 'active',
    serviceDate: snapshot.service_date ?? null,
    shopLocation: snapshot.shop_location ?? null,
    paymentTerm: snapshot.payment_term ?? null,
    voidInfo: snapshot.void_info ? {
      voidedAt: snapshot.void_info.voided_at,
      reason: snapshot.void_info.reason,
      voidedBy: snapshot.void_info.voided_by,
    } : null,
    charges: snapshot.charges.map((charge) => ({
      chargeNumber: charge.charge_number,
      receivedAmount: Number(charge.received_amount),
      items: charge.items.map((item) => ({
        name: item.ice_type_name,
        unit: item.ice_type_unit,
      quantity: Number(item.quantity),
      unitPrice: item.unit_price == null ? null : Number(item.unit_price),
      lineTotal: Number(item.line_total),
      })),
    })),
  };
}

export function methodRequires(profile: PaymentProfile, method: PaymentMethod, field: 'evidence') {
  if (method === 'cash') return profile[`cash_${field}_required`];
  if (method === 'bank_transfer') return profile[`bank_transfer_${field}_required`];
  return profile[`qr_${field}_required`];
}

export function sumChargeOutstanding(charges: QueueShop['charges']) {
  return charges.reduce((sum, charge) => sum + Math.round(Number(charge.outstanding_amount) * 100), 0) / 100;
}

export function allocateOldestFirst(charges: QueueShop['charges'], amount: number) {
  let remaining = Math.round(amount * 100);
  const allocations: Array<{ charge_id: string; amount: number }> = [];
  for (const charge of charges) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, Math.round(Number(charge.outstanding_amount) * 100));
    if (allocated > 0) allocations.push({ charge_id: charge.charge_id, amount: allocated / 100 });
    remaining -= allocated;
  }
  return allocations;
}

export function isPaymentAmountValidForSelection(
  method: PaymentMethod,
  receivedAmount: number,
  selectedOutstandingAmount: number,
) {
  const receivedSatang = Math.round(receivedAmount * 100);
  const outstandingSatang = Math.round(selectedOutstandingAmount * 100);
  return Number.isFinite(receivedAmount)
    && receivedSatang > 0
    && outstandingSatang > 0
    && (method === 'cash' || receivedSatang <= outstandingSatang);
}

function chargeSelectionFingerprint(charges: QueueShop['charges']) {
  return charges.map((charge) => [
    charge.charge_id,
    Number(charge.outstanding_amount).toFixed(2),
  ]);
}

export function reconcileChargeSelection(
  previousCharges: QueueShop['charges'],
  nextCharges: QueueShop['charges'],
  selectedChargeIds: string[],
) {
  const selected = new Set(selectedChargeIds);
  return {
    changed: JSON.stringify(chargeSelectionFingerprint(previousCharges))
      !== JSON.stringify(chargeSelectionFingerprint(nextCharges)),
    selectedChargeIds: nextCharges
      .filter((charge) => selected.has(charge.charge_id))
      .map((charge) => charge.charge_id),
  };
}

export async function withPublicShopImages<T extends PublicImagePathItem>(items: T[]): Promise<T[]> {
  const client = supabase;
  if (!client?.storage) return items;
  const bucket = client.storage.from(SHOP_IMAGE_BUCKET);
  return withAsyncPublicImageUrls(items, (paths) => getHybridObjectUrls(
    SHOP_IMAGE_BUCKET, paths, async (supabasePaths) => supabasePaths.map((path) => ({
      path,
      signedUrl: bucket.getPublicUrl(path).data.publicUrl,
    })),
  ));
}

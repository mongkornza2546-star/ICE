import { supabase } from '../../lib/supabase';
import type {
  PaymentProfile,
  PaymentReceiptSnapshot,
  QueueShop,
  ReceiptCharge,
  ReceiptItemRow,
} from './types';
import type { PaymentMethod } from '../../types/app';

export const USER_AVATAR_BUCKET = 'user-avatars';
export const SHOP_IMAGE_BUCKET = 'shop-images';

export const money = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  minimumFractionDigits: 2,
});

export const receiptDateTime = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'short',
  timeStyle: 'short',
});

const serviceDateFormat = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' });

export function formatServiceDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return serviceDateFormat.format(new Date(year, month - 1, day));
}

export function paymentMethodLabel(method: PaymentMethod) {
  return method === 'cash' ? 'เงินสด' : method === 'bank_transfer' ? 'โอนเงิน' : 'QR';
}

export function receiptChargesFromRows(rows: ReceiptItemRow[]) {
  const charges = new Map<string, ReceiptCharge>();
  for (const row of rows) {
    const chargeNumber = row.charge_number ?? 'ไม่พบเลขที่บิล';
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
    charges: snapshot.charges.map((charge) => ({
      chargeNumber: charge.charge_number,
      receivedAmount: Number(charge.received_amount),
      items: charge.items.map((item) => ({
        name: item.ice_type_name,
        unit: item.ice_type_unit,
        quantity: Number(item.quantity),
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

export function allocateOldestFirst(charges: QueueShop['charges'], amount: number) {
  let remaining = amount;
  const allocations: Array<{ charge_id: string; amount: number }> = [];
  for (const charge of charges) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, Number(charge.outstanding_amount));
    if (allocated > 0) allocations.push({ charge_id: charge.charge_id, amount: allocated });
    remaining -= allocated;
  }
  return allocations;
}

export async function withSignedShopImages(shops: QueueShop[]) {
  if (!supabase?.storage) return shops;
  const imagePaths = shops
    .map((shop) => shop.image_path)
    .filter((path): path is string => Boolean(path));
  if (imagePaths.length === 0) return shops;

  try {
    const { data, error } = await supabase.storage
      .from(SHOP_IMAGE_BUCKET)
      .createSignedUrls(imagePaths, 3600);
    if (error) return shops;
    const imageUrls = new Map(
      (data ?? [])
        .filter((image) => image.path && image.signedUrl)
        .map((image) => [image.path!, image.signedUrl!]),
    );
    return shops.map((shop) => ({
      ...shop,
      image_url: shop.image_path ? imageUrls.get(shop.image_path) ?? null : null,
    }));
  } catch {
    return shops;
  }
}

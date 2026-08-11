import type { ShopPaymentProfile } from '../types/app';

export const OFFLINE_FINGERPRINT_ALGORITHM = 'sha256-canonical-json-v1' as const;

type CanonicalPrimitive = null | boolean | number | string;
export type CanonicalValue = CanonicalPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };

export interface DeliveryFingerprintItem {
  iceTypeId: string;
  unitPrice: number;
  priceSourceId: string;
}

export interface CollectionFingerprintAllocation {
  chargeId: string;
  amount: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CANONICAL_KEY_V1 = /^[A-Za-z0-9_]+$/;

function toMinorUnits(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`);
  const minorUnits = Math.round(value * 100);
  if (!Number.isSafeInteger(minorUnits) || Math.abs(value * 100 - minorUnits) > 1e-7) {
    throw new Error(`${field} must have at most two decimal places`);
  }
  return minorUnits;
}

function canonicalize(value: CanonicalValue): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('canonical JSON v1 numbers must be safe integers');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const keys = Object.keys(value);
  if (keys.some((key) => !CANONICAL_KEY_V1.test(key))) {
    throw new Error('canonical JSON v1 object keys must use printable ASCII letters, digits, or underscore');
  }

  return `{${keys
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

export function canonicalJsonV1(value: CanonicalValue): string {
  return canonicalize(value);
}

export async function fingerprintCanonicalValueV1(value: CanonicalValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonV1(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function paymentProfileFingerprintValue(profile: ShopPaymentProfile): CanonicalValue {
  return {
    algorithm: OFFLINE_FINGERPRINT_ALGORITHM,
    kind: 'payment_profile',
    value: {
      allow_outstanding: profile.allow_outstanding,
      allowed_payment_methods: [...profile.allowed_payment_methods].sort(compareText),
      allowed_payment_terms: [...profile.allowed_payment_terms].sort(compareText),
      bank_transfer_evidence_required: profile.bank_transfer_evidence_required,
      bank_transfer_reference_required: profile.bank_transfer_reference_required,
      cash_evidence_required: profile.cash_evidence_required,
      cash_reference_required: profile.cash_reference_required,
      credit_collection_weekday: profile.credit_collection_weekday,
      credit_days: profile.credit_days,
      credit_due_rule: profile.credit_due_rule,
      credit_exposure_minor: toMinorUnits(profile.credit_exposure, 'credit_exposure'),
      credit_limit_minor:
        profile.credit_limit === null ? null : toMinorUnits(profile.credit_limit, 'credit_limit'),
      credit_remaining_minor:
        profile.credit_remaining === null ? null : toMinorUnits(profile.credit_remaining, 'credit_remaining'),
      credit_suspended: profile.credit_suspended,
      default_payment_method: profile.default_payment_method,
      default_payment_term: profile.default_payment_term,
      qr_evidence_required: profile.qr_evidence_required,
      qr_reference_required: profile.qr_reference_required,
    },
  };
}

export function deliveryPriceFingerprintValue(
  items: DeliveryFingerprintItem[],
  expectedTotal: number,
): CanonicalValue {
  return {
    algorithm: OFFLINE_FINGERPRINT_ALGORITHM,
    kind: 'delivery_prices',
    value: {
      expected_total_minor: toMinorUnits(expectedTotal, 'expectedTotal'),
      items: [...items]
        .sort((left, right) => compareText(left.iceTypeId, right.iceTypeId))
        .map((item) => ({
          ice_type_id: item.iceTypeId,
          price_source_id: item.priceSourceId,
          unit_price_minor: toMinorUnits(item.unitPrice, 'unitPrice'),
        })),
    },
  };
}

export function collectionAllocationFingerprintValue(
  allocations: CollectionFingerprintAllocation[],
  outstandingAmount: number,
): CanonicalValue {
  return {
    algorithm: OFFLINE_FINGERPRINT_ALGORITHM,
    kind: 'collection_allocations',
    value: {
      allocations: [...allocations]
        .sort((left, right) => compareText(left.chargeId, right.chargeId))
        .map((allocation) => ({
          amount_minor: toMinorUnits(allocation.amount, 'allocation.amount'),
          charge_id: allocation.chargeId,
        })),
      outstanding_amount_minor: toMinorUnits(outstandingAmount, 'outstandingAmount'),
    },
  };
}

export function fingerprintPaymentProfile(profile: ShopPaymentProfile): Promise<string> {
  return fingerprintCanonicalValueV1(paymentProfileFingerprintValue(profile));
}

export function fingerprintDeliveryPrices(
  items: DeliveryFingerprintItem[],
  expectedTotal: number,
): Promise<string> {
  return fingerprintCanonicalValueV1(deliveryPriceFingerprintValue(items, expectedTotal));
}

export function fingerprintCollectionAllocations(
  allocations: CollectionFingerprintAllocation[],
  outstandingAmount: number,
): Promise<string> {
  return fingerprintCanonicalValueV1(
    collectionAllocationFingerprintValue(allocations, outstandingAmount),
  );
}

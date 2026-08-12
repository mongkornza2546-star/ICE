export const OFFLINE_COMMAND_SCHEMA_VERSION = 1 as const;
export const OFFLINE_COMMAND_PAYLOAD_VERSION = 1 as const;

export type OfflinePaymentMethodV1 = 'cash' | 'bank_transfer' | 'qr';
export type OfflinePaymentTermV1 = 'immediate' | 'end_of_day' | 'credit';
export type OfflineDeliveryStatusV1 =
  | 'delivered'
  | 'full_bin'
  | 'closed_shop'
  | 'no_access'
  | 'issue';

export const OFFLINE_COMMAND_TYPES = [
  'stock_transfer',
  'stock_return',
  'stock_damage',
  'delivery',
  'immediate_sale',
  'collection_payment',
] as const;

export type OfflineCommandType = (typeof OFFLINE_COMMAND_TYPES)[number];

export const OFFLINE_COMMAND_STATUSES = [
  'pending',
  'syncing',
  'retry_wait',
  'auth_required',
  'conflict',
  'applied',
  'discard_requested',
  'discard_approved',
] as const;

export type OfflineCommandStatus = (typeof OFFLINE_COMMAND_STATUSES)[number];

export const OFFLINE_SYNC_ERROR_CODES = [
  'ROUND_CLOSED',
  'STOCK_DAY_CLOSED',
  'INSUFFICIENT_STOCK',
  'PRICE_CHANGED',
  'OUTSTANDING_CHANGED',
  'PAYMENT_PROFILE_CHANGED',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'ROUND_ASSIGNMENT_CHANGED',
  'USER_INACTIVE',
  'COLLECTION_RUN_CLOSED',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'INVALID_SCHEMA_VERSION',
  'INVALID_PAYLOAD_VERSION',
  'INVALID_PAYLOAD',
  'DEVICE_MISMATCH',
  'OWNER_MISMATCH',
  'SERVICE_DATE_EXPIRED',
  'SERVER_CONTRACT_ERROR',
  'NETWORK_ERROR',
  'SERVER_UNAVAILABLE',
  'AUTH_REQUIRED',
  'EVIDENCE_UPLOAD_FAILED',
] as const;

export type OfflineSyncErrorCode = (typeof OFFLINE_SYNC_ERROR_CODES)[number];

export interface OfflineSyncError {
  code: OfflineSyncErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ExpectedDeliveryItem {
  iceTypeId: string;
  quantity: number;
  expectedUnitPrice: number;
  expectedPriceSourceId: string;
}

export interface OfflineEvidenceReferenceV1 {
  evidenceId: string;
  remotePath: string;
  checksumSha256: string;
}

export interface StockMovementPayload {
  roundId: string;
  items: Array<{ iceTypeId: string; quantity: number }>;
  expectedSourceLocationId: string;
  expectedTargetLocationId: string | null;
}

export interface DeliveryPayload {
  roundStopId: string;
  status: OfflineDeliveryStatusV1;
  note: string | null;
  items: ExpectedDeliveryItem[];
  paymentTerm: Exclude<OfflinePaymentTermV1, 'immediate'> | null;
  approvalId: string | null;
  expectedTotal: number | null;
  expectedPaymentProfileFingerprint: string | null;
}

export interface ImmediateSalePayload {
  roundStopId: string;
  note: string | null;
  items: ExpectedDeliveryItem[];
  paymentMethod: OfflinePaymentMethodV1;
  receivedAmount: number;
  referenceNumber: string | null;
  evidence: OfflineEvidenceReferenceV1 | null;
  expectedTotal: number;
  expectedPaymentProfileFingerprint: string;
}

export interface CollectionPaymentPayload {
  collectionRunId: string;
  shopId: string;
  allocations: Array<{ chargeId: string; amount: number }>;
  paymentMethod: OfflinePaymentMethodV1;
  receivedAmount: number;
  referenceNumber: string | null;
  evidence: OfflineEvidenceReferenceV1 | null;
  expectedOutstandingAmount: number;
  expectedPaymentProfileFingerprint: string;
  expectedAllocationFingerprint: string;
}

export interface CommandPayloadMap {
  stock_transfer: StockMovementPayload;
  stock_return: StockMovementPayload;
  stock_damage: StockMovementPayload;
  delivery: DeliveryPayload;
  immediate_sale: ImmediateSalePayload;
  collection_payment: CollectionPaymentPayload;
}

export interface OfflineStockBalanceItemV1 {
  ice_type_id: string;
  ice_type_name: string;
  unit: string;
  quantity: number;
}

export interface OfflineEmployeeStockLocationV1 {
  id: string;
  code: string;
  name: string;
  balances: OfflineStockBalanceItemV1[];
}

export interface OfflineEmployeeStockStateV1 {
  round_id: string;
  service_date: string;
  withdrawn_balances: OfflineStockBalanceItemV1[];
  truck_location: OfflineEmployeeStockLocationV1;
  holding_location: OfflineEmployeeStockLocationV1;
}

interface OfflineStoredSalesDocumentBaseV1 {
  document_number: string;
  document_title: string;
  shop_code: string;
  shop_name: string;
  shop_location: string | null;
  status: 'active' | 'voided';
  void_info: { voided_at: string; reason: string; voided_by?: string | null } | null;
}

export interface OfflineStoredInvoiceV1 extends OfflineStoredSalesDocumentBaseV1 {
  document_type: 'INV';
  issued_at: string;
  service_date: string;
  due_date: string;
  payment_term: Exclude<OfflinePaymentTermV1, 'immediate'>;
  total_amount: number;
  items: Array<{
    ice_type_name: string;
    ice_type_unit: string;
    quantity: number;
    unit_price: number;
    line_total: number;
  }>;
}

export interface OfflineStoredReceiptV1 extends OfflineStoredSalesDocumentBaseV1 {
  document_type: 'REC';
  recorded_at: string;
  service_date: string;
  payment_term: OfflinePaymentTermV1 | null;
  payment_method: OfflinePaymentMethodV1;
  received_amount: number;
  allocated_amount: number;
  change_amount: number;
  charges: Array<{
    charge_number: string | null;
    payment_term: OfflinePaymentTermV1;
    service_date: string;
    location: string | null;
    received_amount: number;
    items: Array<{
      ice_type_name: string;
      ice_type_unit: string;
      quantity: number;
      unit_price: number;
      line_total: number;
    }>;
  }>;
}

export type OfflineStoredSalesDocumentV1 = OfflineStoredInvoiceV1 | OfflineStoredReceiptV1;

export interface OfflineDeliveryItemResultV1 {
  ice_type_id: string;
  name: string;
  unit: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  price_source: 'standard' | 'shop_override' | null;
  price_source_id: string | null;
}

export interface OfflineDeliveryResultV1 {
  delivery_event_id: string;
  round_stop_id: string;
  charge_id: string | null;
  charge_number: string | null;
  service_date: string | null;
  total_amount: number | null;
  payment_term: OfflinePaymentTermV1 | null;
  payment_status: 'unpaid' | 'partial' | 'paid' | null;
  due_date: string | null;
  approval_id: string | null;
  print_document: OfflineStoredInvoiceV1 | null;
  items: OfflineDeliveryItemResultV1[];
}

export interface OfflinePaymentResultV1 {
  payment_id: string;
  receipt_number: string;
  shop_id: string;
  payment_method: OfflinePaymentMethodV1;
  received_amount: number;
  allocated_amount: number;
  change_amount: number;
  status: 'active' | 'voided';
  recorded_at: string;
}

export interface OfflineImmediateSaleResultV1 {
  delivery: OfflineDeliveryResultV1;
  payment: OfflinePaymentResultV1;
  receipt_number: string;
  print_document: OfflineStoredReceiptV1;
}

export interface OfflineCollectionPaymentResultV1 extends OfflinePaymentResultV1 {
  print_document: OfflineStoredReceiptV1;
}

export interface CommandResultMap {
  stock_transfer: OfflineEmployeeStockStateV1;
  stock_return: OfflineEmployeeStockStateV1;
  stock_damage: OfflineEmployeeStockStateV1;
  delivery: OfflineDeliveryResultV1;
  immediate_sale: OfflineImmediateSaleResultV1;
  collection_payment: OfflineCollectionPaymentResultV1;
}

export interface OfflineCommandBase<TType extends OfflineCommandType> {
  schemaVersion: typeof OFFLINE_COMMAND_SCHEMA_VERSION;
  payloadVersion: typeof OFFLINE_COMMAND_PAYLOAD_VERSION;
  commandId: string;
  idempotencyKey: string;
  deviceId: string;
  ownerId: string;
  serviceDate: string;
  sequence: number;
  type: TType;
  payload: CommandPayloadMap[TType];
  clientRecordedAt: string;
  createdAt: string;
  status: OfflineCommandStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: OfflineSyncError | null;
  serverResult: CommandResultMap[TType] | null;
  serverResolutionVersion: number;
}

export type OfflineCommand = {
  [TType in OfflineCommandType]: OfflineCommandBase<TType>;
}[OfflineCommandType];

export interface OfflineCommandEnvelope {
  schemaVersion: typeof OFFLINE_COMMAND_SCHEMA_VERSION;
  payloadVersion: typeof OFFLINE_COMMAND_PAYLOAD_VERSION;
  commandId: string;
  idempotencyKey: string;
  deviceId: string;
  ownerId: string;
  serviceDate: string;
  sequence: number;
  clientRecordedAt: string;
}

export type OfflineSyncResponse<TType extends OfflineCommandType = OfflineCommandType> =
  | {
      status: 'applied';
      command_id: string;
      resolution_version: number;
      result: CommandResultMap[TType];
    }
  | { status: 'retryable'; command_id: string; error: OfflineSyncError }
  | { status: 'auth_required'; command_id: string; error: OfflineSyncError }
  | {
      status: 'conflict';
      command_id: string;
      issue_id: string;
      resolution_version: number;
      error: OfflineSyncError;
    };

export interface OfflineResolutionFeed {
  nextCursor: number;
  resolutions: Array<{
    commandId: string;
    status: 'applied' | 'conflict' | 'retry_requested' | 'discard_approved';
    resolutionVersion: number;
    issueId: string | null;
    result: unknown | null;
  }>;
}

export interface OfflineContractValidation {
  valid: boolean;
  issues: string[];
}

const PAYMENT_METHODS: readonly OfflinePaymentMethodV1[] = ['cash', 'bank_transfer', 'qr'];
const PAYMENT_TERMS: readonly OfflinePaymentTermV1[] = ['immediate', 'end_of_day', 'credit'];
const DELIVERY_STATUSES: readonly OfflineDeliveryStatusV1[] = [
  'delivered',
  'full_bin',
  'closed_shop',
  'no_access',
  'issue',
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SERVICE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isServiceDate(value: unknown): value is string {
  if (typeof value !== 'string' || !SERVICE_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year === 0) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const [, year, month, day, hour, minute, second, offset, offsetHour, offsetMinute] = match;
  if (
    Number(year) === 0 ||
    !isServiceDate(`${year}-${month}-${day}`) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offset !== 'Z' && (Number(offsetHour) > 15 || Number(offsetMinute) > 59))
  ) return false;

  return Number.isFinite(Date.parse(value));
}

function minorUnits(value: unknown): number | null {
  if (!isNonNegativeNumber(value)) return null;
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(value * 100 - minor) > 1e-7) return null;
  return minor;
}

function isMoney(value: unknown): value is number {
  return minorUnits(value) !== null;
}

function isPositiveMoney(value: unknown): value is number {
  const minor = minorUnits(value);
  return minor !== null && minor > 0;
}

function isPositiveIntegerQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPositiveHalfQuantity(value: unknown): value is number {
  return isPositiveNumber(value) && Number.isSafeInteger(value * 2);
}

function isNonNegativeHalfQuantity(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isSafeInteger(value * 2);
}

function roundedLineTotalMinor(quantity: unknown, unitPrice: unknown): number | null {
  if (!isPositiveHalfQuantity(quantity)) return null;
  const unitPriceMinor = minorUnits(unitPrice);
  if (unitPriceMinor === null) return null;

  const halfUnits = quantity * 2;
  const unroundedHalfSatang = halfUnits * unitPriceMinor;
  if (!Number.isSafeInteger(unroundedHalfSatang)) return null;
  return Math.round(unroundedHalfSatang / 2);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasDistinctIds(items: unknown[], field: string): boolean {
  const ids = items
    .filter(isRecord)
    .map((item) => item[field])
    .filter((id): id is string => typeof id === 'string');
  return ids.length === new Set(ids).size;
}

function validateExpectedItems(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    hasDistinctIds(value, 'iceTypeId') &&
    value.every(
      (item) =>
        isRecord(item) &&
        hasOnlyKeys(item, [
          'iceTypeId',
          'quantity',
          'expectedUnitPrice',
          'expectedPriceSourceId',
        ]) &&
        isUuid(item.iceTypeId) &&
        isPositiveHalfQuantity(item.quantity) &&
        isMoney(item.expectedUnitPrice) &&
        isUuid(item.expectedPriceSourceId),
    )
  );
}

function validateStockPayload(
  payload: unknown,
  validateQuantity: (value: unknown) => boolean,
): boolean {
  if (!isRecord(payload)) return false;
  return (
    hasOnlyKeys(payload, [
      'roundId',
      'items',
      'expectedSourceLocationId',
      'expectedTargetLocationId',
    ]) &&
    isUuid(payload.roundId) &&
    Array.isArray(payload.items) &&
    payload.items.length > 0 &&
    hasDistinctIds(payload.items, 'iceTypeId') &&
    payload.items.every(
      (item) =>
        isRecord(item) &&
        hasOnlyKeys(item, ['iceTypeId', 'quantity']) &&
        isUuid(item.iceTypeId) &&
        validateQuantity(item.quantity),
    ) &&
    isUuid(payload.expectedSourceLocationId) &&
    (payload.expectedTargetLocationId === null || isUuid(payload.expectedTargetLocationId))
  );
}

function expectedItemsTotalMinor(items: unknown[]): number | null {
  let total = 0;
  for (const item of items) {
    if (!isRecord(item)) return null;
    const lineTotal = roundedLineTotalMinor(item.quantity, item.expectedUnitPrice);
    if (lineTotal === null) return null;
    total += lineTotal;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function validateDeliveryPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const structurallyValid =
    hasOnlyKeys(payload, [
      'roundStopId',
      'status',
      'note',
      'items',
      'paymentTerm',
      'approvalId',
      'expectedTotal',
      'expectedPaymentProfileFingerprint',
    ]) &&
    isUuid(payload.roundStopId) &&
    DELIVERY_STATUSES.includes(payload.status as OfflineDeliveryStatusV1) &&
    isNullableString(payload.note) &&
    validateExpectedItems(payload.items) &&
    (payload.paymentTerm === null || payload.paymentTerm === 'end_of_day' || payload.paymentTerm === 'credit') &&
    (payload.approvalId === null || isUuid(payload.approvalId)) &&
    (payload.expectedTotal === null || isMoney(payload.expectedTotal)) &&
    (payload.expectedPaymentProfileFingerprint === null ||
      (typeof payload.expectedPaymentProfileFingerprint === 'string' &&
        SHA256_HEX.test(payload.expectedPaymentProfileFingerprint)));
  if (!structurallyValid) return false;

  if (payload.status === 'delivered') {
    return (
      (payload.items as unknown[]).length > 0 &&
      payload.paymentTerm !== null &&
      payload.expectedTotal !== null &&
      typeof payload.expectedPaymentProfileFingerprint === 'string' &&
      SHA256_HEX.test(payload.expectedPaymentProfileFingerprint) &&
      expectedItemsTotalMinor(payload.items as unknown[]) === minorUnits(payload.expectedTotal)
    );
  }

  return (
    isNonBlankString(payload.note) &&
    (payload.items as unknown[]).length === 0 &&
    payload.paymentTerm === null &&
    payload.approvalId === null &&
    payload.expectedTotal === null &&
    payload.expectedPaymentProfileFingerprint === null
  );
}

function validateEvidenceReference(
  value: unknown,
  ownerId: unknown,
  idempotencyKey: unknown,
): value is OfflineEvidenceReferenceV1 {
  if (!isRecord(value) || !isUuid(ownerId) || !isUuid(idempotencyKey)) return false;
  return (
    hasOnlyKeys(value, ['evidenceId', 'remotePath', 'checksumSha256']) &&
    isUuid(value.evidenceId) &&
    typeof value.remotePath === 'string' &&
    new RegExp(`^${ownerId}/${idempotencyKey}\\.(?:jpg|jpeg|png|webp|pdf)$`).test(value.remotePath) &&
    typeof value.checksumSha256 === 'string' &&
    SHA256_HEX.test(value.checksumSha256)
  );
}

function validateImmediateSalePayload(payload: unknown, ownerId: unknown, idempotencyKey: unknown): boolean {
  if (!isRecord(payload)) return false;
  const structurallyValid =
    hasOnlyKeys(payload, [
      'roundStopId',
      'note',
      'items',
      'paymentMethod',
      'receivedAmount',
      'referenceNumber',
      'evidence',
      'expectedTotal',
      'expectedPaymentProfileFingerprint',
    ]) &&
    isUuid(payload.roundStopId) &&
    isNullableString(payload.note) &&
    validateExpectedItems(payload.items) &&
    (payload.items as unknown[]).length > 0 &&
    PAYMENT_METHODS.includes(payload.paymentMethod as OfflinePaymentMethodV1) &&
    isPositiveMoney(payload.receivedAmount) &&
    isNullableString(payload.referenceNumber) &&
    (payload.evidence === null || validateEvidenceReference(payload.evidence, ownerId, idempotencyKey)) &&
    isPositiveMoney(payload.expectedTotal) &&
    typeof payload.expectedPaymentProfileFingerprint === 'string' &&
    SHA256_HEX.test(payload.expectedPaymentProfileFingerprint);
  if (!structurallyValid) return false;

  const total = minorUnits(payload.expectedTotal);
  const received = minorUnits(payload.receivedAmount);
  return (
    expectedItemsTotalMinor(payload.items as unknown[]) === total &&
    total !== null &&
    received !== null &&
    (payload.paymentMethod === 'cash' ? received >= total : received === total)
  );
}

function validateCollectionPaymentPayload(payload: unknown, ownerId: unknown, idempotencyKey: unknown): boolean {
  if (!isRecord(payload)) return false;
  const structurallyValid =
    hasOnlyKeys(payload, [
      'collectionRunId',
      'shopId',
      'allocations',
      'paymentMethod',
      'receivedAmount',
      'referenceNumber',
      'evidence',
      'expectedOutstandingAmount',
      'expectedPaymentProfileFingerprint',
      'expectedAllocationFingerprint',
    ]) &&
    isUuid(payload.collectionRunId) &&
    isUuid(payload.shopId) &&
    Array.isArray(payload.allocations) &&
    payload.allocations.length > 0 &&
    hasDistinctIds(payload.allocations, 'chargeId') &&
    payload.allocations.every(
      (allocation) =>
        isRecord(allocation) &&
        hasOnlyKeys(allocation, ['chargeId', 'amount']) &&
        isUuid(allocation.chargeId) &&
        isPositiveMoney(allocation.amount),
    ) &&
    PAYMENT_METHODS.includes(payload.paymentMethod as OfflinePaymentMethodV1) &&
    isPositiveMoney(payload.receivedAmount) &&
    isNullableString(payload.referenceNumber) &&
    (payload.evidence === null || validateEvidenceReference(payload.evidence, ownerId, idempotencyKey)) &&
    isMoney(payload.expectedOutstandingAmount) &&
    typeof payload.expectedPaymentProfileFingerprint === 'string' &&
    SHA256_HEX.test(payload.expectedPaymentProfileFingerprint) &&
    typeof payload.expectedAllocationFingerprint === 'string' &&
    SHA256_HEX.test(payload.expectedAllocationFingerprint);
  if (!structurallyValid) return false;

  const allocated = (payload.allocations as Array<Record<string, unknown>>).reduce(
    (total, allocation) => total + (minorUnits(allocation.amount) ?? 0),
    0,
  );
  const received = minorUnits(payload.receivedAmount);
  const outstanding = minorUnits(payload.expectedOutstandingAmount);
  return (
    Number.isSafeInteger(allocated) &&
    received !== null &&
    outstanding !== null &&
    allocated <= received &&
    allocated <= outstanding &&
    (payload.paymentMethod === 'cash' || received === allocated)
  );
}

function validatePayload(
  type: OfflineCommandType,
  payload: unknown,
  ownerId: unknown,
  idempotencyKey: unknown,
): boolean {
  switch (type) {
    case 'stock_transfer':
      return (
        validateStockPayload(payload, isPositiveIntegerQuantity) &&
        isRecord(payload) &&
        isUuid(payload.expectedTargetLocationId) &&
        payload.expectedSourceLocationId !== payload.expectedTargetLocationId
      );
    case 'stock_return':
      return (
        validateStockPayload(payload, isPositiveHalfQuantity) &&
        isRecord(payload) &&
        isUuid(payload.expectedTargetLocationId) &&
        payload.expectedSourceLocationId !== payload.expectedTargetLocationId
      );
    case 'stock_damage':
      return validateStockPayload(payload, isPositiveHalfQuantity) && isRecord(payload) && payload.expectedTargetLocationId === null;
    case 'delivery':
      return validateDeliveryPayload(payload);
    case 'immediate_sale':
      return validateImmediateSalePayload(payload, ownerId, idempotencyKey);
    case 'collection_payment':
      return validateCollectionPaymentPayload(payload, ownerId, idempotencyKey);
  }
}

function validateStockBalance(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['ice_type_id', 'ice_type_name', 'unit', 'quantity']) &&
    isUuid(value.ice_type_id) &&
    isNonBlankString(value.ice_type_name) &&
    isNonBlankString(value.unit) &&
    isNonNegativeHalfQuantity(value.quantity)
  );
}

function validateStockLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'code', 'name', 'balances']) &&
    isUuid(value.id) &&
    isNonBlankString(value.code) &&
    isNonBlankString(value.name) &&
    Array.isArray(value.balances) &&
    value.balances.every(validateStockBalance)
  );
}

function validateEmployeeStockState(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'round_id', 'service_date', 'withdrawn_balances', 'truck_location', 'holding_location',
    ]) &&
    isUuid(value.round_id) &&
    isServiceDate(value.service_date) &&
    Array.isArray(value.withdrawn_balances) &&
    value.withdrawn_balances.every(validateStockBalance) &&
    validateStockLocation(value.truck_location) &&
    validateStockLocation(value.holding_location)
  );
}

function validateStoredSalesItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['ice_type_name', 'ice_type_unit', 'quantity', 'unit_price', 'line_total']) &&
    isNonBlankString(value.ice_type_name) &&
    isNonBlankString(value.ice_type_unit) &&
    isPositiveHalfQuantity(value.quantity) &&
    isMoney(value.unit_price) &&
    isMoney(value.line_total) &&
    roundedLineTotalMinor(value.quantity, value.unit_price) === minorUnits(value.line_total)
  );
}

function sumLineTotalsMinor(items: unknown[]): number | null {
  let total = 0;
  for (const item of items) {
    if (!isRecord(item)) return null;
    const lineTotal = minorUnits(item.line_total);
    if (lineTotal === null) return null;
    total += lineTotal;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function salesItemsMatchDeliveryItems(documentItems: unknown[], deliveryItems: unknown[]): boolean {
  if (documentItems.length !== deliveryItems.length) return false;
  const unmatched = [...deliveryItems];

  for (const documentItem of documentItems) {
    if (!isRecord(documentItem)) return false;
    const matchIndex = unmatched.findIndex((deliveryItem) => (
      isRecord(deliveryItem) &&
      documentItem.ice_type_name === deliveryItem.name &&
      documentItem.ice_type_unit === deliveryItem.unit &&
      documentItem.quantity === deliveryItem.quantity &&
      minorUnits(documentItem.unit_price) === minorUnits(deliveryItem.unit_price) &&
      minorUnits(documentItem.line_total) === minorUnits(deliveryItem.line_total)
    ));
    if (matchIndex < 0) return false;
    unmatched.splice(matchIndex, 1);
  }

  return unmatched.length === 0;
}

function validateDocumentStatus(value: Record<string, unknown>): boolean {
  if (value.status === 'active') return value.void_info === null;
  return (
    value.status === 'voided' &&
    isRecord(value.void_info) &&
    hasOnlyKeys(value.void_info, ['voided_at', 'reason', 'voided_by']) &&
    isTimestamp(value.void_info.voided_at) &&
    isNonBlankString(value.void_info.reason) &&
    (value.void_info.voided_by === undefined || isNullableString(value.void_info.voided_by))
  );
}

function validateStoredSalesDocumentBase(value: Record<string, unknown>): boolean {
  return (
    isNonBlankString(value.document_number) &&
    isNonBlankString(value.document_title) &&
    isNonBlankString(value.shop_code) &&
    isNonBlankString(value.shop_name) &&
    isNullableString(value.shop_location) &&
    validateDocumentStatus(value)
  );
}

function validateStoredInvoice(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      'document_type', 'document_number', 'document_title', 'status', 'issued_at',
      'service_date', 'due_date', 'shop_code', 'shop_name', 'shop_location',
      'payment_term', 'total_amount', 'items', 'void_info',
    ]) &&
    validateStoredSalesDocumentBase(value) &&
    isTimestamp(value.issued_at) &&
    isServiceDate(value.service_date) &&
    isServiceDate(value.due_date) &&
    (value.payment_term === 'end_of_day' || value.payment_term === 'credit') &&
    isPositiveMoney(value.total_amount) &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.every(validateStoredSalesItem) &&
    sumLineTotalsMinor(value.items) === minorUnits(value.total_amount)
  );
}

function validateStoredReceiptCharge(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'charge_number', 'payment_term', 'service_date', 'location', 'received_amount', 'items',
    ]) &&
    (value.charge_number === null || isNonBlankString(value.charge_number)) &&
    PAYMENT_TERMS.includes(value.payment_term as OfflinePaymentTermV1) &&
    isServiceDate(value.service_date) &&
    isNullableString(value.location) &&
    isPositiveMoney(value.received_amount) &&
    Array.isArray(value.items) &&
    value.items.length > 0 &&
    value.items.every(validateStoredSalesItem)
  );
}

function validateStoredReceipt(value: Record<string, unknown>): boolean {
  if (
    !hasOnlyKeys(value, [
      'document_type', 'document_number', 'document_title', 'status', 'recorded_at',
      'service_date', 'shop_code', 'shop_name', 'shop_location', 'payment_term',
      'payment_method', 'received_amount', 'allocated_amount', 'change_amount',
      'charges', 'void_info',
    ]) ||
    !validateStoredSalesDocumentBase(value) ||
    !isTimestamp(value.recorded_at) ||
    !isServiceDate(value.service_date) ||
    (value.payment_term !== null && !PAYMENT_TERMS.includes(value.payment_term as OfflinePaymentTermV1)) ||
    !PAYMENT_METHODS.includes(value.payment_method as OfflinePaymentMethodV1) ||
    !isPositiveMoney(value.received_amount) ||
    !isPositiveMoney(value.allocated_amount) ||
    !isMoney(value.change_amount) ||
    !Array.isArray(value.charges) ||
    value.charges.length === 0 ||
    !value.charges.every(validateStoredReceiptCharge)
  ) return false;

  const received = minorUnits(value.received_amount);
  const allocated = minorUnits(value.allocated_amount);
  const change = minorUnits(value.change_amount);
  const chargeTotal = value.charges.reduce((total, charge) => (
    total + (isRecord(charge) ? (minorUnits(charge.received_amount) ?? 0) : 0)
  ), 0);
  return (
    received !== null && allocated !== null && change !== null &&
    Number.isSafeInteger(chargeTotal) && chargeTotal === allocated &&
    received - allocated === change &&
    (value.payment_method === 'cash' || change === 0)
  );
}

function validateStoredSalesDocument(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.document_type === 'INV') return validateStoredInvoice(value);
  if (value.document_type === 'REC') return validateStoredReceipt(value);
  return false;
}

function validateDeliveryItemResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'ice_type_id', 'name', 'unit', 'quantity', 'unit_price', 'line_total',
      'price_source', 'price_source_id',
    ]) &&
    isUuid(value.ice_type_id) &&
    isNonBlankString(value.name) &&
    isNonBlankString(value.unit) &&
    isPositiveHalfQuantity(value.quantity) &&
    (
      (
        value.unit_price === null && value.line_total === null &&
        value.price_source === null && value.price_source_id === null
      ) || (
        isMoney(value.unit_price) && isMoney(value.line_total) &&
        roundedLineTotalMinor(value.quantity, value.unit_price) === minorUnits(value.line_total) &&
        (value.price_source === 'standard' || value.price_source === 'shop_override') &&
        isUuid(value.price_source_id)
      )
    )
  );
}

function validateDeliveryResult(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'delivery_event_id', 'round_stop_id', 'charge_id', 'charge_number', 'service_date',
      'total_amount', 'payment_term', 'payment_status', 'due_date', 'approval_id',
      'print_document', 'items',
    ]) ||
    !isUuid(value.delivery_event_id) ||
    !isUuid(value.round_stop_id) ||
    (value.charge_id !== null && !isUuid(value.charge_id)) ||
    (value.charge_number !== null && !isNonBlankString(value.charge_number)) ||
    (value.service_date !== null && !isServiceDate(value.service_date)) ||
    (value.total_amount !== null && !isMoney(value.total_amount)) ||
    (value.payment_term !== null && !PAYMENT_TERMS.includes(value.payment_term as OfflinePaymentTermV1)) ||
    (value.payment_status !== null && value.payment_status !== 'unpaid' &&
      value.payment_status !== 'partial' && value.payment_status !== 'paid') ||
    (value.due_date !== null && !isServiceDate(value.due_date)) ||
    (value.approval_id !== null && !isUuid(value.approval_id)) ||
    (value.print_document !== null && !validateStoredSalesDocument(value.print_document)) ||
    !Array.isArray(value.items) ||
    !value.items.every(validateDeliveryItemResult)
  ) return false;

  if (value.charge_id === null) {
    return (
      value.charge_number === null && value.service_date === null && value.total_amount === null &&
      value.payment_term === null && value.payment_status === null && value.due_date === null &&
      value.approval_id === null && value.print_document === null && value.items.length === 0
    );
  }

  if (
    !isServiceDate(value.service_date) || !isPositiveMoney(value.total_amount) ||
    value.items.length === 0 ||
    sumLineTotalsMinor(value.items) !== minorUnits(value.total_amount)
  ) return false;

  if (value.payment_term === 'immediate') {
    return (
      value.charge_number === null && value.payment_status === 'paid' &&
      value.due_date === null && value.print_document === null
    );
  }

  return (
    (value.payment_term === 'end_of_day' || value.payment_term === 'credit') &&
    isNonBlankString(value.charge_number) &&
    isServiceDate(value.due_date) &&
    isRecord(value.print_document) &&
    value.print_document.document_type === 'INV' &&
    value.print_document.document_number === value.charge_number &&
    value.print_document.service_date === value.service_date &&
    value.print_document.due_date === value.due_date &&
    value.print_document.payment_term === value.payment_term &&
    minorUnits(value.print_document.total_amount) === minorUnits(value.total_amount) &&
    Array.isArray(value.print_document.items) &&
    salesItemsMatchDeliveryItems(value.print_document.items, value.items)
  );
}

function validatePaymentResult(value: unknown, includePrintDocument = false): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'payment_id', 'receipt_number', 'shop_id', 'payment_method', 'received_amount',
      'allocated_amount', 'change_amount', 'status', 'recorded_at',
      ...(includePrintDocument ? ['print_document'] : []),
    ]) &&
    isUuid(value.payment_id) &&
    isNonBlankString(value.receipt_number) &&
    isUuid(value.shop_id) &&
    PAYMENT_METHODS.includes(value.payment_method as OfflinePaymentMethodV1) &&
    isPositiveMoney(value.received_amount) &&
    isPositiveMoney(value.allocated_amount) &&
    isMoney(value.change_amount) &&
    (value.status === 'active' || value.status === 'voided') &&
    isTimestamp(value.recorded_at)
  );
}

function validateReceiptMatchesPayment(receipt: unknown, payment: unknown): boolean {
  return (
    isRecord(receipt) &&
    receipt.document_type === 'REC' &&
    isRecord(payment) &&
    receipt.document_number === payment.receipt_number &&
    receipt.payment_method === payment.payment_method &&
    minorUnits(receipt.received_amount) === minorUnits(payment.received_amount) &&
    minorUnits(receipt.allocated_amount) === minorUnits(payment.allocated_amount) &&
    minorUnits(receipt.change_amount) === minorUnits(payment.change_amount) &&
    receipt.recorded_at === payment.recorded_at &&
    receipt.status === payment.status
  );
}

function validateImmediateSaleReceiptMatchesDelivery(receipt: unknown, delivery: unknown): boolean {
  if (!isRecord(receipt) || !isRecord(delivery) || !Array.isArray(receipt.charges)) return false;
  if (receipt.payment_term !== 'immediate' || receipt.charges.length !== 1) return false;
  const charge = receipt.charges[0];
  return (
    isRecord(charge) &&
    charge.charge_number === null &&
    charge.payment_term === 'immediate' &&
    charge.service_date === delivery.service_date &&
    minorUnits(charge.received_amount) === minorUnits(delivery.total_amount) &&
    Array.isArray(charge.items) &&
    Array.isArray(delivery.items) &&
    salesItemsMatchDeliveryItems(charge.items, delivery.items)
  );
}

function validateCommandResult(type: OfflineCommandType, value: unknown): boolean {
  switch (type) {
    case 'stock_transfer':
    case 'stock_return':
    case 'stock_damage':
      return validateEmployeeStockState(value);
    case 'delivery':
      return validateDeliveryResult(value);
    case 'immediate_sale':
      return (
        isRecord(value) &&
        hasOnlyKeys(value, ['delivery', 'payment', 'receipt_number', 'print_document']) &&
        validateDeliveryResult(value.delivery) &&
        validatePaymentResult(value.payment) &&
        isNonBlankString(value.receipt_number) &&
        validateStoredSalesDocument(value.print_document) &&
        isRecord(value.payment) &&
        value.receipt_number === value.payment.receipt_number &&
        validateReceiptMatchesPayment(value.print_document, value.payment) &&
        validateImmediateSaleReceiptMatchesDelivery(value.print_document, value.delivery) &&
        isRecord(value.delivery) &&
        minorUnits(value.delivery.total_amount) === minorUnits(value.payment.allocated_amount)
      );
    case 'collection_payment':
      return (
        validatePaymentResult(value, true) &&
        isRecord(value) &&
        validateStoredSalesDocument(value.print_document) &&
        validateReceiptMatchesPayment(value.print_document, value)
      );
  }
}

function validateSyncError(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['code', 'message', 'details']) &&
    OFFLINE_SYNC_ERROR_CODES.includes(value.code as OfflineSyncErrorCode) &&
    isNonBlankString(value.message) &&
    (!('details' in value) || value.details === undefined || isRecord(value.details))
  );
}

export function validateOfflineSyncResponse(
  type: OfflineCommandType,
  input: unknown,
): OfflineContractValidation {
  if (!isRecord(input)) return { valid: false, issues: ['sync response must be an object'] };
  const issues: string[] = [];
  if (!isUuid(input.command_id)) issues.push('command_id must be a UUID v4');

  switch (input.status) {
    case 'applied':
      if (!hasOnlyKeys(input, ['status', 'command_id', 'resolution_version', 'result'])) {
        issues.push('applied response contains fields outside the v1 allowlist');
      }
      if (!isNonNegativeInteger(input.resolution_version) || input.resolution_version === 0) {
        issues.push('resolution_version must be a positive integer');
      }
      if (!validateCommandResult(type, input.result)) {
        issues.push(`result does not match ${type} result v1`);
      }
      break;
    case 'retryable':
    case 'auth_required':
      if (!hasOnlyKeys(input, ['status', 'command_id', 'error'])) {
        issues.push(`${input.status} response contains fields outside the v1 allowlist`);
      }
      if (!validateSyncError(input.error)) issues.push('error does not match OfflineSyncError v1');
      break;
    case 'conflict':
      if (!hasOnlyKeys(input, ['status', 'command_id', 'issue_id', 'resolution_version', 'error'])) {
        issues.push('conflict response contains fields outside the v1 allowlist');
      }
      if (!isUuid(input.issue_id)) issues.push('issue_id must be a UUID v4');
      if (!isNonNegativeInteger(input.resolution_version) || input.resolution_version === 0) {
        issues.push('resolution_version must be a positive integer');
      }
      if (!validateSyncError(input.error)) issues.push('error does not match OfflineSyncError v1');
      break;
    default:
      issues.push('unsupported sync response status');
  }

  return { valid: issues.length === 0, issues };
}

export function validateOfflineCommand(input: unknown): OfflineContractValidation {
  if (!isRecord(input)) return { valid: false, issues: ['command must be an object'] };

  const issues: string[] = [];
  if (
    !hasOnlyKeys(input, [
      'schemaVersion',
      'payloadVersion',
      'commandId',
      'idempotencyKey',
      'deviceId',
      'ownerId',
      'serviceDate',
      'sequence',
      'type',
      'payload',
      'clientRecordedAt',
      'createdAt',
      'status',
      'attempts',
      'nextAttemptAt',
      'lastError',
      'serverResult',
      'serverResolutionVersion',
    ])
  ) {
    issues.push('command contains fields outside the v1 allowlist');
  }
  if (input.schemaVersion !== OFFLINE_COMMAND_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (input.payloadVersion !== OFFLINE_COMMAND_PAYLOAD_VERSION) issues.push('unsupported payloadVersion');
  for (const field of ['commandId', 'idempotencyKey', 'deviceId', 'ownerId']) {
    if (!isUuid(input[field])) issues.push(`${field} must be a UUID v4`);
  }
  if (!isServiceDate(input.serviceDate)) issues.push('serviceDate must be a valid YYYY-MM-DD date');
  if (!isTimestamp(input.clientRecordedAt)) issues.push('clientRecordedAt must be a timestamp');
  if (!isTimestamp(input.createdAt)) issues.push('createdAt must be a timestamp');
  if (!isNonNegativeInteger(input.sequence) || input.sequence === 0) issues.push('sequence must be a positive integer');
  if (!OFFLINE_COMMAND_TYPES.includes(input.type as OfflineCommandType)) issues.push('unsupported command type');
  if (!OFFLINE_COMMAND_STATUSES.includes(input.status as OfflineCommandStatus)) issues.push('unsupported command status');
  if (!isNonNegativeInteger(input.attempts)) issues.push('attempts must be a non-negative integer');
  if (input.nextAttemptAt !== null && !isTimestamp(input.nextAttemptAt)) {
    issues.push('nextAttemptAt must be a timestamp or null');
  }
  if (input.lastError !== null && !validateSyncError(input.lastError)) {
    issues.push('lastError does not match OfflineSyncError v1');
  }
  if (!isNonNegativeInteger(input.serverResolutionVersion)) {
    issues.push('serverResolutionVersion must be a non-negative integer');
  } else if (
    (input.status === 'applied' || input.status === 'conflict' || input.status === 'discard_approved') &&
    input.serverResolutionVersion === 0
  ) {
    issues.push('serverResolutionVersion must be positive for resolved commands');
  }

  if (
    OFFLINE_COMMAND_TYPES.includes(input.type as OfflineCommandType) &&
    !validatePayload(
      input.type as OfflineCommandType,
      input.payload,
      input.ownerId,
      input.idempotencyKey,
    )
  ) {
    issues.push(`payload does not match ${String(input.type)} v1`);
  }
  if (OFFLINE_COMMAND_TYPES.includes(input.type as OfflineCommandType)) {
    if (input.status === 'applied' && !validateCommandResult(input.type as OfflineCommandType, input.serverResult)) {
      issues.push(`serverResult does not match ${String(input.type)} result v1`);
    } else if (input.status !== 'applied' && input.serverResult !== null) {
      issues.push('serverResult must be null until the command is applied');
    }
  }

  return { valid: issues.length === 0, issues };
}

export function isOfflineCommand(input: unknown): input is OfflineCommand {
  return validateOfflineCommand(input).valid;
}

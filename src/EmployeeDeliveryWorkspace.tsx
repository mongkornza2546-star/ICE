import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarBlank, CaretDown, CheckCircle, Printer, WarningCircle } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import type {
  DeliveryFinancialResult,
  DeliveryPosContext,
  DeliveryRound,
  EmployeeStockState,
  FinancialPaymentResult,
  ImmediateSaleResult,
  IceTypeOption,
  PaymentMethod,
  PaymentTerm,
  ShopCard,
  ShopCardHistoryEntry,
  ShopRoundStatus,
} from './types/app';
import { EmployeeState } from './features/employee-delivery/EmployeeState';
import { EmployeeStockTransferSection } from './features/employee-delivery/EmployeeStockTransferSection';
import { EmployeeShopPicker } from './features/employee-delivery/EmployeeShopPicker';
import { EmployeeCasualCustomerPage } from './features/employee-delivery/EmployeeCasualCustomerPage';
import { EmployeeDeliveryReview } from './features/employee-delivery/EmployeeDeliveryReview';
import { useEmployeeDeliveryData } from './features/employee-delivery/useEmployeeDeliveryData';
import { toBangkokDateString } from './lib/serviceDate';
import { deletePaymentEvidence, uploadPaymentEvidence } from './lib/paymentEvidence';
import { withAsyncPublicImageUrls } from './lib/publicImageUrls';
import { getHybridObjectUrls } from './lib/r2Storage';
import { subscribeToDataChange } from './lib/dataChange';

export interface EmployeeDeliveryPayload {
  roundStopId: string;
  items: Array<{ ice_type_id: string; quantity: number }>;
  status: Exclude<ShopRoundStatus, 'pending'>;
  note: string | null;
  clientRecordedAt: string;
  idempotencyKey: string;
  paymentTerm: PaymentTerm | null;
  approvalId?: string | null;
}

export interface EmployeePaymentPayload {
  shopId: string;
  chargeId: string;
  paymentMethod: PaymentMethod;
  receivedAmount: number;
  allocatedAmount: number;
  referenceNumber: string | null;
  evidencePath: string | null;
  expectedOutstandingAmount: number;
  approvalId: string | null;
  idempotencyKey: string;
}

export interface EmployeeImmediateSalePayload {
  roundStopId: string;
  items: Array<{ ice_type_id: string; quantity: number }>;
  note: string | null;
  clientRecordedAt: string;
  paymentMethod: PaymentMethod;
  receivedAmount: number;
  referenceNumber: string | null;
  evidencePath: string | null;
  expectedTotal: number;
  idempotencyKey: string;
}

export interface EmployeeApprovalPayload {
  roundStopId: string;
  kind: 'credit_limit' | 'outstanding_balance';
  items: Array<{ ice_type_id: string; quantity: number }>;
  paymentTerm: PaymentTerm;
  requestedAmount: number;
  reason: string;
  chargeId?: string | null;
}

export interface EmployeeStockTransferPayload {
  roundId: string;
  items: Array<{ ice_type_id: string; quantity: number }>;
  idempotencyKey: string;
}

export interface EmployeeDeliveryGateway {
  loadReferenceData(serviceDate: string): Promise<{ rounds: DeliveryRound[]; iceTypes: IceTypeOption[] }>;
  loadShopCards(roundId: string, options?: { forceRefresh?: boolean }): Promise<ShopCard[]>;
  loadDeliveryPosContext?(roundStopId: string, options?: {
    serviceDate?: string;
    forceRefresh?: boolean;
  }): Promise<DeliveryPosContext>;
  invalidateDeliveryPosContextCache?(roundStopId?: string): void;
  loadEmployeeStockState(roundId: string): Promise<EmployeeStockState>;
  recordEmployeeStockTransfer(payload: EmployeeStockTransferPayload): Promise<EmployeeStockState>;
  recordEmployeeStockReturn(payload: EmployeeStockTransferPayload): Promise<EmployeeStockState>;
  recordEmployeeStockDamage(payload: EmployeeStockTransferPayload): Promise<EmployeeStockState>;
  recordDelivery(payload: EmployeeDeliveryPayload): Promise<DeliveryFinancialResult | void>;
  recordPayment?(payload: EmployeePaymentPayload): Promise<FinancialPaymentResult>;
  recordImmediateSale?(payload: EmployeeImmediateSalePayload): Promise<ImmediateSaleResult>;
  uploadPaymentEvidence?(file: File, idempotencyKey: string): Promise<string>;
  deletePaymentEvidence?(path: string, idempotencyKey: string): Promise<void>;
  requestFinancialApproval?(payload: EmployeeApprovalPayload): Promise<{
    id: string;
    status: 'pending' | 'approved' | 'rejected' | 'consumed';
  }>;
}

export interface EmployeeDeliveryDraftState {
  dirty: boolean;
  submitting: boolean;
}

const POS_CONTEXT_FRESH_MS = 5 * 60 * 1000;
const POS_CONTEXT_CACHE_PREFIX = 'ice-employee-pos-context:v1';
const SHOP_CARDS_BURST_CACHE_MS = 5 * 1000;
const FOREGROUND_REFRESH_MIN_MS = 5 * 60 * 1000;

interface CachedPosContext {
  cachedAt: number;
  context: DeliveryPosContext;
}

function posContextCacheKey(serviceDate: string, roundStopId: string) {
  return `${POS_CONTEXT_CACHE_PREFIX}:${serviceDate}:${roundStopId}`;
}

function readStoredPosContext(serviceDate: string, roundStopId: string): CachedPosContext | null {
  try {
    const raw = window.localStorage.getItem(posContextCacheKey(serviceDate, roundStopId));
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedPosContext;
    if (cached.context?.round_stop_id !== roundStopId
      || cached.context?.service_date !== serviceDate
      || typeof cached.cachedAt !== 'number') {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function writeStoredPosContext(context: DeliveryPosContext, cachedAt: number) {
  const cacheableContext: DeliveryPosContext = {
    ...context,
    client_cache: undefined,
    items: context.items.map((item) => ({ ...item, image_url: null })),
  };
  try {
    window.localStorage.setItem(
      posContextCacheKey(context.service_date, context.round_stop_id),
      JSON.stringify({ cachedAt, context: cacheableContext } satisfies CachedPosContext),
    );
  } catch {
    // Network data remains usable even when browser storage is unavailable or full.
  }
}

function clearStoredPosContexts(roundStopId?: string) {
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(`${POS_CONTEXT_CACHE_PREFIX}:`)) continue;
      if (!roundStopId || key.endsWith(`:${roundStopId}`)) window.localStorage.removeItem(key);
    }
  } catch {
    // An unavailable cache must not block a server refresh.
  }
}

function markPosContextCache(context: DeliveryPosContext, cachedAt: number, stale: boolean) {
  return {
    ...context,
    client_cache: {
      cached_at: new Date(cachedAt).toISOString(),
      stale,
    },
  };
}

function singleFlight<T>(requests: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
  const existing = requests.get(key);
  if (existing) return existing;
  const request = load().finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  requests.set(key, request);
  return request;
}

async function withPublicIceTypeOptions(iceTypes: IceTypeOption[]): Promise<IceTypeOption[]> {
  const client = supabase;
  if (!client) return iceTypes;
  const bucket = client.storage.from('ice-type-images');
  return withAsyncPublicImageUrls(iceTypes, (paths) => getHybridObjectUrls(
    'ice-type-images', paths, async (supabasePaths) => supabasePaths.map((path) => ({
      path,
      signedUrl: bucket.getPublicUrl(path).data.publicUrl,
    })),
  ));
}

function formatEmployeeServiceDate(serviceDate: string) {
  return new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${serviceDate}T12:00:00+07:00`));
}

export function createSupabaseGateway(): EmployeeDeliveryGateway {
  const referenceRequests = new Map<string, Promise<{ rounds: DeliveryRound[]; iceTypes: IceTypeOption[] }>>();
  const shopCardRequests = new Map<string, Promise<ShopCard[]>>();
  const stockRequests = new Map<string, Promise<EmployeeStockState>>();
  const posContextRequests = new Map<string, Promise<DeliveryPosContext>>();
  const posContextMemoryCache = new Map<string, CachedPosContext>();
  const shopCardBurstCache = new Map<string, { cachedAt: number; cards: ShopCard[] }>();

  const invalidatePosContextCache = (roundStopId?: string) => {
    for (const key of posContextMemoryCache.keys()) {
      if (!roundStopId || key.endsWith(`:${roundStopId}`)) posContextMemoryCache.delete(key);
    }
    clearStoredPosContexts(roundStopId);
  };

  return {
    async loadReferenceData(serviceDate) {
      return singleFlight(referenceRequests, serviceDate, async () => {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
        const [sessionResponse, iceTypesResponse] = await Promise.all([
          supabase.rpc('get_employee_active_session', { p_service_date: serviceDate }),
          supabase
            .from('ice_types')
            .select('id, code, name, unit, image_path')
            .eq('is_active', true)
            .order('code'),
        ]);

        if (sessionResponse.error) throw sessionResponse.error;
        if (iceTypesResponse.error) throw iceTypesResponse.error;
        return {
          rounds: (sessionResponse.data?.sessions ?? []) as DeliveryRound[],
          iceTypes: await withPublicIceTypeOptions((iceTypesResponse.data ?? []) as IceTypeOption[]),
        };
      });
    },
    async loadShopCards(roundId, options) {
      if (options?.forceRefresh) {
        const inFlight = shopCardRequests.get(roundId);
        if (inFlight) await inFlight.catch(() => undefined);
        shopCardBurstCache.delete(roundId);
      }
      const cached = shopCardBurstCache.get(roundId);
      if (cached && Date.now() - cached.cachedAt < SHOP_CARDS_BURST_CACHE_MS) return cached.cards;
      return singleFlight(shopCardRequests, roundId, async () => {
        const client = supabase;
        if (!client) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
        const { error: syncError } = await client.rpc('sync_daily_round_active_shops', {
          p_round_id: roundId,
        });
        if (syncError) throw syncError;
        const { data, error } = await client.rpc('get_round_shop_cards', {
          p_round_id: roundId,
          p_building_id: null,
        });
        if (error) throw error;
        const rawCards = (data ?? []) as Array<
          Omit<ShopCard, 'today_history'> & { today_history: ShopCardHistoryEntry[] | null }
        >;
        const shopImageBucket = client.storage.from('shop-images');
        const cardsWithImages = await withAsyncPublicImageUrls(
          rawCards,
          (paths) => getHybridObjectUrls(
            'shop-images', paths, async (supabasePaths) => supabasePaths.map((path) => ({
              path,
              signedUrl: shopImageBucket.getPublicUrl(path).data.publicUrl,
            })),
          ),
        );
        const cards: ShopCard[] = cardsWithImages.map((card) => ({
          ...card,
          image_url: card.image_url ?? null,
          today_history: Array.isArray(card.today_history) ? card.today_history : [],
        }));
        shopCardBurstCache.set(roundId, { cachedAt: Date.now(), cards });
        return cards;
      });
    },
    async loadEmployeeStockState(roundId) {
      return singleFlight(stockRequests, roundId, async () => {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
        const { data, error } = await supabase.rpc('get_employee_stock_state', {
          p_round_id: roundId,
        });
        if (error) throw error;
        return data as EmployeeStockState;
      });
    },
    async loadDeliveryPosContext(roundStopId, options) {
      const serviceDate = options?.serviceDate ?? '';
      const key = `${serviceDate}:${roundStopId}`;
      const stored = serviceDate
        ? posContextMemoryCache.get(key) ?? readStoredPosContext(serviceDate, roundStopId)
        : null;
      if (stored) posContextMemoryCache.set(key, stored);
      if (!options?.forceRefresh && stored && Date.now() - stored.cachedAt < POS_CONTEXT_FRESH_MS) {
        return markPosContextCache(stored.context, stored.cachedAt, false);
      }

      return singleFlight(posContextRequests, key, async () => {
        try {
          if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
          const { data, error } = await supabase.rpc('get_delivery_pos_context', {
            p_round_stop_id: roundStopId,
          });
          if (error) throw error;
          const context = data as DeliveryPosContext;
          const cachedAt = Date.now();
          const cached = { cachedAt, context };
          const resolvedKey = `${context.service_date}:${roundStopId}`;
          posContextMemoryCache.set(resolvedKey, cached);
          writeStoredPosContext(context, cachedAt);
          return markPosContextCache(context, cachedAt, false);
        } catch (loadError) {
          if (stored) return markPosContextCache(stored.context, stored.cachedAt, true);
          throw loadError;
        }
      });
    },
    invalidateDeliveryPosContextCache(roundStopId) {
      invalidatePosContextCache(roundStopId);
    },
    async recordEmployeeStockTransfer(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_employee_stock_transfer', {
        p_round_id: payload.roundId,
        p_items: payload.items,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
      invalidatePosContextCache();
      return data as EmployeeStockState;
    },
    async recordEmployeeStockReturn(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_employee_stock_return', {
        p_round_id: payload.roundId,
        p_items: payload.items,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
      invalidatePosContextCache();
      return data as EmployeeStockState;
    },
    async recordEmployeeStockDamage(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_employee_stock_damage', {
        p_round_id: payload.roundId,
        p_items: payload.items,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
      invalidatePosContextCache();
      return data as EmployeeStockState;
    },
    async recordDelivery(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_delivery', {
        p_round_stop_id: payload.roundStopId,
        p_items: payload.items,
        p_stop_status: payload.status,
        p_note: payload.note,
        p_client_recorded_at: payload.clientRecordedAt,
        p_idempotency_key: payload.idempotencyKey,
        p_payment_term: payload.paymentTerm,
        p_approval_id: payload.approvalId ?? null,
      });
      if (error) throw error;
      invalidatePosContextCache(payload.roundStopId);
      return data as DeliveryFinancialResult;
    },
    async recordPayment(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_payment', {
        p_shop_id: payload.shopId,
        p_allocations: [{ charge_id: payload.chargeId, amount: payload.allocatedAmount }],
        p_payment_method: payload.paymentMethod,
        p_received_amount: payload.receivedAmount,
        p_reference_number: payload.referenceNumber,
        p_evidence_path: payload.evidencePath,
        p_collection_run_id: null,
        p_expected_outstanding_amount: payload.expectedOutstandingAmount,
        p_approval_id: payload.approvalId,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
      invalidatePosContextCache();
      return data as FinancialPaymentResult;
    },
    async recordImmediateSale(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_immediate_sale', {
        p_round_stop_id: payload.roundStopId,
        p_items: payload.items,
        p_note: payload.note,
        p_client_recorded_at: payload.clientRecordedAt,
        p_payment_method: payload.paymentMethod,
        p_received_amount: payload.receivedAmount,
        p_reference_number: payload.referenceNumber,
        p_evidence_path: payload.evidencePath,
        p_expected_total: payload.expectedTotal,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
      invalidatePosContextCache(payload.roundStopId);
      return data as ImmediateSaleResult;
    },
    async uploadPaymentEvidence(file, idempotencyKey) {
      return uploadPaymentEvidence(file, idempotencyKey);
    },
    async deletePaymentEvidence(path, idempotencyKey) {
      return deletePaymentEvidence(path, idempotencyKey);
    },
    async requestFinancialApproval(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('request_financial_approval', {
        p_round_stop_id: payload.roundStopId,
        p_kind: payload.kind,
        p_items: payload.items,
        p_payment_term: payload.paymentTerm,
        p_requested_amount: payload.requestedAmount,
        p_reason: payload.reason,
        p_charge_id: payload.chargeId ?? null,
      });
      if (error) throw error;
      return data as { id: string; status: 'pending' | 'approved' | 'rejected' | 'consumed' };
    },
  };
}

const productionGateway = createSupabaseGateway();

export function EmployeeDeliveryWorkspace({
  casualCustomerPreviewEnabled = false,
  gateway = productionGateway,
  enableAssignedStockFlow = false,
  isActive = true,
  onDraftStateChange,
  requestScope = 'default',
  serviceDate = toBangkokDateString(),
  stockSourceLabel = 'สต๊อกรวมประจำวัน',
  viewMode,
}: {
  casualCustomerPreviewEnabled?: boolean;
  gateway?: EmployeeDeliveryGateway;
  enableAssignedStockFlow?: boolean;
  isActive?: boolean;
  onDraftStateChange?: (state: EmployeeDeliveryDraftState) => void;
  requestScope?: string;
  serviceDate?: string;
  stockSourceLabel?: string;
  viewMode?: 'pos' | 'withdrawal';
}) {
  const resolvedViewMode = viewMode ?? (enableAssignedStockFlow ? 'combined' : 'pos');
  const isBackdatedBilling = !enableAssignedStockFlow && serviceDate < toBangkokDateString();
  const [deliveryDraftState, setDeliveryDraftState] = useState<EmployeeDeliveryDraftState>({
    dirty: false,
    submitting: false,
  });
  const [casualCustomerOpen, setCasualCustomerOpen] = useState(false);
  const casualCustomerButtonRef = useRef<HTMLButtonElement>(null);
  const casualCustomerBrowseScrollY = useRef(0);
  const casualCustomerReturnFocusPending = useRef(false);
  const lastForegroundRefreshAt = useRef(Date.now());
  const catalogRefreshPending = useRef(false);
  const data = useEmployeeDeliveryData({
    gateway,
    enableAssignedStockFlow,
    requestScope,
    serviceDate,
    stockSourceLabel,
    onDraftStateChange: setDeliveryDraftState,
  });
  const anySubmittingRef = useRef(data.anySubmitting);
  anySubmittingRef.current = data.anySubmitting;

  useEffect(() => {
    setCasualCustomerOpen(false);
    casualCustomerReturnFocusPending.current = false;
  }, [casualCustomerPreviewEnabled, data.selectedRoundId, isActive, requestScope, resolvedViewMode, serviceDate]);

  useLayoutEffect(() => {
    if (casualCustomerOpen || !casualCustomerReturnFocusPending.current) return;
    casualCustomerReturnFocusPending.current = false;
    casualCustomerButtonRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: casualCustomerBrowseScrollY.current, behavior: 'auto' });
  }, [casualCustomerOpen]);

  useEffect(() => {
    onDraftStateChange?.(deliveryDraftState);
  }, [deliveryDraftState, onDraftStateChange]);

  useEffect(() => {
    if (!isActive) {
      catalogRefreshPending.current = true;
      return;
    }
    if (data.anySubmitting || !catalogRefreshPending.current) return;
    catalogRefreshPending.current = false;
    data.refreshShopCatalog();
  }, [data.anySubmitting, data.refreshShopCatalog, isActive]);

  useEffect(() => subscribeToDataChange(['stock', 'pos'], () => {
    if (!isActive || data.anySubmitting) return;
    gateway.invalidateDeliveryPosContextCache?.();
    data.retryLoad();
  }), [data.anySubmitting, data.retryLoad, gateway, isActive]);

  useEffect(() => {
    if (!isActive) return undefined;
    const refreshOnFocus = () => {
      const now = Date.now();
      if (now - lastForegroundRefreshAt.current < FOREGROUND_REFRESH_MIN_MS) return;
      lastForegroundRefreshAt.current = now;
      if (!data.anySubmitting) data.retryLoad();
    };
    const refreshFromCatalogChange = () => {
      if (anySubmittingRef.current) {
        catalogRefreshPending.current = true;
        return;
      }
      data.refreshShopCatalog();
    };
    window.addEventListener('focus', refreshOnFocus);

    const client = supabase;
    if (!client) {
      return () => window.removeEventListener('focus', refreshOnFocus);
    }

    const channel = client
      .channel(`employee-shop-catalog:${requestScope}:${serviceDate}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'shops',
      }, refreshFromCatalogChange)
      .subscribe();

    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      void client.removeChannel(channel);
    };
  }, [data.refreshShopCatalog, data.retryLoad, isActive, requestScope, serviceDate]);

  if (data.loadingReference) {
    return <EmployeeState
      title={isBackdatedBilling ? `กำลังโหลดงานวันที่ ${serviceDate}` : 'กำลังโหลดงานวันนี้'}
      detail="ดึงงานประจำวันและชนิดน้ำแข็ง"
    />;
  }

  if (!data.error && data.iceTypes.length === 0) {
    return <EmployeeState title="ยังไม่มีชนิดน้ำแข็งที่ใช้งาน" detail="ให้แอดมินเปิดใช้งานชนิดน้ำแข็งอย่างน้อย 1 รายการก่อนบันทึกส่ง" />;
  }

  if (data.selectedCard && data.selectedRound) {
    return (
      <div className="employee-workspace">
        <EmployeeDeliveryReview
        assignedStockState={enableAssignedStockFlow ? data.stockState : null}
        atomicImmediateSale={Boolean(gateway.recordImmediateSale)}
        deliveryQuantities={data.deliveryQuantities}
        posContext={data.posContext}
        posContextError={data.posContextError}
        loadingPosContext={data.loadingPosContext}
        paymentTerm={data.paymentTerm}
        paymentResult={data.paymentResult}
        paymentOpen={data.paymentOpen}
        paymentMethod={data.paymentMethod}
        paymentAmount={data.paymentAmount}
        paymentReference={data.paymentReference}
        paymentEvidence={data.paymentEvidence}
        paymentEvidenceUploaded={data.paymentEvidenceUploaded}
        paymentSubmitting={data.paymentSubmitting}
        approvalId={data.approvalId}
        approvalReason={data.approvalReason}
        approvalSubmitting={data.approvalSubmitting}
        enableAssignedStockFlow={enableAssignedStockFlow}
        entryError={data.entryError}
        iceTypes={data.iceTypes}
        items={data.items}
        note={data.note}
        onBack={data.attemptBack}
        onChangeShop={data.changeShop}
        onChooseProblemStatus={data.chooseProblemStatus}
        onSetQuantity={data.setDeliveryQuantity}
        onClearCart={data.clearDeliveryQuantities}
        onPaymentTermChange={data.setPaymentTerm}
        onPaymentMethodChange={data.setPaymentMethod}
        onPaymentAmountChange={data.setPaymentAmount}
        onPaymentReferenceChange={data.setPaymentReference}
        onPaymentEvidenceChange={data.setPaymentEvidence}
        onPaymentCancel={data.cancelImmediateSaleDraft}
        onPaymentSubmit={data.handlePaymentSubmit}
        onApprovalReasonChange={data.setApprovalReason}
        onRequestApproval={data.handleRequestApproval}
        onNoteChange={data.setNote}
        onReturnToDelivery={data.returnToDelivery}
        onCorrectionSuccess={() => { data.retryLoad(); }}
        onSubmit={data.handleSubmit}
        problemOpen={data.problemOpen}
        round={data.selectedRound}
        shopCard={data.selectedCard}
        shopCards={data.filteredCards}
        status={data.status}
        stockSourceLabel={stockSourceLabel}
          submitting={data.submitting}
        />
      </div>
    );
  }

  const openRounds = data.rounds.filter((r) => r.status === 'open' && !r.cancelled_at);
  const casualCustomerAvailable = Boolean(
    casualCustomerPreviewEnabled
    && data.selectedRound?.status === 'open'
    && !data.selectedRound.cancelled_at
    && resolvedViewMode !== 'withdrawal',
  );

  if (casualCustomerOpen && casualCustomerAvailable && data.selectedRound) {
    return (
      <div className="employee-workspace">
        <EmployeeCasualCustomerPage
          onBack={() => {
            casualCustomerReturnFocusPending.current = true;
            setCasualCustomerOpen(false);
          }}
          round={data.selectedRound}
          serviceDateLabel={formatEmployeeServiceDate(data.selectedRound.service_date)}
        />
      </div>
    );
  }

  return (
    <div className={`employee-workspace ${resolvedViewMode === 'withdrawal' ? 'employee-workspace--withdrawal' : ''}`}>
      <section className="employee-intro">
        <div>
          <p className="employee-eyebrow">{isBackdatedBilling ? 'ออกบิลย้อนหลัง · เฉพาะแอดมิน' : 'งานพนักงาน'}</p>
          <h1>{resolvedViewMode === 'withdrawal'
            ? 'เติม คืน และบันทึกน้ำแข็งละลาย'
            : isBackdatedBilling
              ? `เลือกร้านเพื่อออกบิลวันที่ ${serviceDate}`
              : 'เลือกร้าน แล้วบันทึกส่ง'}</h1>
          <p>{resolvedViewMode === 'withdrawal'
            ? 'เติมจากรถเข้าจุดถือครอง คืนของที่เหลือกลับขึ้นรถ หรือบันทึกน้ำแข็งละลายจากสต๊อกของคุณ'
            : 'เลือกร้านก่อน ระบบจะตรวจสต๊อกต้นทาง ราคา และเงื่อนไขชำระของร้านนั้น'}</p>
        </div>
        {data.selectedRound ? (
          <div className={`employee-round-badge ${data.selectedRound.status === 'closed' ? 'employee-round-badge--closed' : ''}`}>
            {resolvedViewMode === 'withdrawal' ? <CalendarBlank aria-hidden="true" size={24} weight="duotone" /> : null}
            <span>
              <strong>{isBackdatedBilling ? 'งานย้อนหลัง' : data.selectedRound.name}</strong>
              <small>{formatEmployeeServiceDate(data.selectedRound.service_date)}</small>
            </span>
            {resolvedViewMode === 'withdrawal' && openRounds.length > 1
              ? <CaretDown aria-hidden="true" size={16} weight="bold" />
              : null}
          </div>
        ) : null}
      </section>

      {openRounds.length > 1 ? (
        <section className="employee-filters employee-filters--round" aria-label="เลือกงาน">
          <label className="employee-round-select">
            <span>เลือกงาน</span>
            <select disabled={data.anySubmitting} value={data.selectedRoundId} onChange={(event) => data.chooseRound(event.target.value)}>
              <option value="">เลือกงาน</option>
              {data.rounds.map((round) => (
                <option key={round.id} value={round.id}>
                  {round.name} · {round.service_date} · {round.cancelled_at ? 'ยกเลิก' : round.status === 'open' ? 'กำลังดำเนินการ' : 'ปิดแล้ว'}
                </option>
              ))}
            </select>
          </label>
        </section>
      ) : null}

      {data.success ? <div aria-live="polite" className="employee-success">
        <CheckCircle aria-hidden="true" size={22} weight="fill" />
        <span>{data.success}</span>
        {data.latestReceiptAvailable ? <button className="employee-success__print" onClick={data.printLatestReceipt} type="button">
          <Printer aria-hidden="true" size={18} />พิมพ์ใบเสร็จ
        </button> : null}
      </div> : null}
      {data.error ? (
        <div className="employee-error employee-error--retry" role="alert">
          <span><WarningCircle aria-hidden="true" size={22} weight="fill" />{data.error}</span>
          <button disabled={data.loadingCards || data.loadingReference} onClick={data.retryLoad} type="button">ลองใหม่</button>
        </div>
      ) : null}

      {openRounds.length === 0 ? (
        <section className="employee-state" aria-labelledby="employee-no-open-round">
          <WarningCircle aria-hidden="true" size={42} />
          <h2 id="employee-no-open-round">{isBackdatedBilling
            ? 'วันที่นี้ไม่มีรอบส่งที่เปิดอยู่'
            : 'ยังไม่มีรอบส่งที่เปิดอยู่'}</h2>
          <p>{isBackdatedBilling
            ? 'ไม่สามารถเพิ่มบิลลงในวันที่ปิดรอบแล้วได้ เพื่อไม่ให้ยอดสต๊อกที่ปิดวันเปลี่ยนย้อนหลัง'
            : 'หัวหน้ารอบต้องเปิดรอบส่งและเพิ่มคุณเข้ารอบก่อน จึงจะเลือกร้านและบันทึกส่งได้'}</p>
          <button className="employee-text-button" disabled={data.loadingReference} onClick={data.retryLoad} type="button">โหลดรอบอีกครั้ง</button>
        </section>
      ) : (
        <>
          {resolvedViewMode === 'withdrawal' || resolvedViewMode === 'combined' ? (
            <EmployeeStockTransferSection
              stockError={data.stockError}
              transferSubmitting={data.transferSubmitting}
              loadStockState={data.loadStockState}
              selectedRoundId={data.selectedRoundId}
              stockState={data.stockState}
              iceTypes={data.iceTypes}
              transferQuantities={data.transferQuantities}
              changeTransferQuantity={data.changeTransferQuantity}
              stockTransferMode={data.stockTransferMode}
              changeStockTransferMode={data.changeStockTransferMode}
              selectedRound={data.selectedRound}
              handleStockTransfer={data.handleStockTransfer}
              resetTransferQuantities={() => {
                data.iceTypes.forEach((iceType) => {
                  const quantity = data.transferQuantities[iceType.id] ?? 0;
                  if (quantity > 0) data.changeTransferQuantity(iceType.id, -quantity);
                });
              }}
              variant={resolvedViewMode === 'withdrawal' ? 'cards' : 'table'}
              transferItems={data.transferItems}
            />
          ) : null}

          {resolvedViewMode === 'pos' || resolvedViewMode === 'combined' ? <EmployeeShopPicker
            enableAssignedStockFlow={enableAssignedStockFlow}
            selectedRoundId={data.selectedRoundId}
            query={data.query}
            setQuery={data.setQuery}
            selectedBuildingId={data.selectedBuildingId}
            setSelectedBuildingId={data.setSelectedBuildingId}
            buildingOptions={data.buildingOptions}
            selectedZone={data.selectedZone}
            setSelectedZone={data.setSelectedZone}
            zoneOptions={data.zoneOptions}
            loadingCards={data.loadingCards}
            filteredCards={data.filteredCards}
            casualCustomerButtonRef={casualCustomerButtonRef}
            casualCustomerEntryVisible={casualCustomerAvailable}
            openCasualCustomer={() => {
              if (!casualCustomerAvailable) return;
              casualCustomerBrowseScrollY.current = window.scrollY;
              setCasualCustomerOpen(true);
              window.scrollTo({ top: 0, behavior: 'auto' });
            }}
            openCard={data.openCard}
            stockState={data.stockState}
            shopButtonRefs={data.shopButtonRefs}
          /> : null}
        </>
      )}
    </div>
  );
}

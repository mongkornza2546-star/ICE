import { useEffect, useState } from 'react';
import { CheckCircle, Printer, WarningCircle } from '@phosphor-icons/react';
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
import { EmployeeDeliveryReview } from './features/employee-delivery/EmployeeDeliveryReview';
import { useEmployeeDeliveryData } from './features/employee-delivery/useEmployeeDeliveryData';
import { toBangkokDateString } from './lib/serviceDate';
import { deletePaymentEvidence, uploadPaymentEvidence } from './lib/paymentEvidence';

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
  loadShopCards(roundId: string): Promise<ShopCard[]>;
  loadDeliveryPosContext?(roundStopId: string): Promise<DeliveryPosContext>;
  loadEmployeeStockState(roundId: string): Promise<EmployeeStockState>;
  recordEmployeeStockTransfer(payload: EmployeeStockTransferPayload): Promise<EmployeeStockState>;
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

async function withSignedIceTypeImages(context: DeliveryPosContext): Promise<DeliveryPosContext> {
  if (!supabase) return context;
  const imagePaths = context.items
    .map((item) => item.image_path)
    .filter((path): path is string => Boolean(path));
  if (imagePaths.length === 0) return context;
  const { data: signedData, error: imageError } = await supabase.storage
    .from('ice-type-images')
    .createSignedUrls(imagePaths, 3600);
  if (imageError) return context;
  const imageUrls = new Map(
    (signedData ?? [])
      .filter((entry) => entry.path && entry.signedUrl)
      .map((entry) => [entry.path!, entry.signedUrl!]),
  );
  return {
    ...context,
    items: context.items.map((item) => ({
      ...item,
      image_url: item.image_path ? imageUrls.get(item.image_path) ?? null : null,
    })),
  };
}

function createSupabaseGateway(): EmployeeDeliveryGateway {
  return {
    async loadReferenceData(serviceDate) {
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
        iceTypes: (iceTypesResponse.data ?? []) as IceTypeOption[],
      };
    },
    async loadShopCards(roundId) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('get_round_shop_cards', {
        p_round_id: roundId,
        p_building_id: null,
      });
      if (error) throw error;
      const rawCards = (data ?? []) as Array<
        Omit<ShopCard, 'image_url' | 'today_history'> & { today_history: ShopCardHistoryEntry[] | null }
      >;
      const imagePaths = rawCards.map((card) => card.image_path).filter((path): path is string => Boolean(path));
      const imageMap = new Map<string, string>();
      if (imagePaths.length > 0) {
        const { data: signedData, error: imageError } = await supabase.storage
          .from('shop-images')
          .createSignedUrls(imagePaths, 3600);
        if (!imageError) {
          for (const entry of signedData ?? []) {
            if (entry.path && entry.signedUrl) imageMap.set(entry.path, entry.signedUrl);
          }
        }
      }
      return rawCards.map((card) => ({
        ...card,
        image_url: card.image_path ? imageMap.get(card.image_path) ?? null : null,
        today_history: Array.isArray(card.today_history) ? card.today_history : [],
      }));
    },
    async loadEmployeeStockState(roundId) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('get_employee_stock_state', {
        p_round_id: roundId,
      });
      if (error) throw error;
      return data as EmployeeStockState;
    },
    async loadDeliveryPosContext(roundStopId) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('get_delivery_pos_context', {
        p_round_stop_id: roundStopId,
      });
      if (error) throw error;
      return withSignedIceTypeImages(data as DeliveryPosContext);
    },
    async recordEmployeeStockTransfer(payload) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error } = await supabase.rpc('record_employee_stock_transfer', {
        p_round_id: payload.roundId,
        p_items: payload.items,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
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
  gateway = productionGateway,
  enableAssignedStockFlow = false,
  onDraftStateChange,
  requestScope = 'default',
  serviceDate = toBangkokDateString(),
  stockSourceLabel = 'สต๊อกรวมประจำวัน',
  viewMode,
}: {
  gateway?: EmployeeDeliveryGateway;
  enableAssignedStockFlow?: boolean;
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
  const data = useEmployeeDeliveryData({
    gateway,
    enableAssignedStockFlow,
    requestScope,
    serviceDate,
    stockSourceLabel,
    onDraftStateChange: setDeliveryDraftState,
  });

  useEffect(() => {
    onDraftStateChange?.(deliveryDraftState);
  }, [deliveryDraftState, onDraftStateChange]);

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

  return (
    <div className="employee-workspace">
      <section className="employee-intro">
        <div>
          <p className="employee-eyebrow">{isBackdatedBilling ? 'ออกบิลย้อนหลัง · เฉพาะแอดมิน' : 'งานพนักงาน'}</p>
          <h1>{resolvedViewMode === 'withdrawal'
            ? 'เบิกน้ำแข็ง'
            : isBackdatedBilling
              ? `เลือกร้านเพื่อออกบิลวันที่ ${serviceDate}`
              : 'เลือกร้าน แล้วบันทึกส่ง'}</h1>
          <p>{resolvedViewMode === 'withdrawal'
            ? 'เบิกน้ำแข็งจากคลังเข้าจุดถือครองเพื่อเริ่มงาน'
            : 'เลือกร้านก่อน ระบบจะตรวจสต๊อกต้นทาง ราคา และเงื่อนไขชำระของร้านนั้น'}</p>
        </div>
        {data.selectedRound ? (
          <div className={`employee-round-badge ${data.selectedRound.status === 'closed' ? 'employee-round-badge--closed' : ''}`}>
            <strong>{isBackdatedBilling ? 'งานย้อนหลัง' : 'งานวันนี้'}: {data.selectedRound.name}</strong>
            <span>{data.selectedRound.service_date} · {data.selectedRound.cancelled_at ? 'ยกเลิกแล้ว' : data.selectedRound.status === 'open' ? 'กำลังดำเนินการ' : 'ปิดแล้ว'}</span>
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
              selectedRound={data.selectedRound}
              handleStockTransfer={data.handleStockTransfer}
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
            openCard={data.openCard}
            stockState={data.stockState}
            shopButtonRefs={data.shopButtonRefs}
          /> : null}
        </>
      )}
    </div>
  );
}

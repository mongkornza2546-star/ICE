import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { supabase } from './lib/supabase';
import type { DeliveryRound, EmployeeStockState, IceTypeOption, ShopCard, ShopCardHistoryEntry, ShopRoundStatus } from './types/app';
import { EmployeeState } from './features/employee-delivery/EmployeeState';
import { EmployeeStockTransferSection } from './features/employee-delivery/EmployeeStockTransferSection';
import { EmployeeShopPicker } from './features/employee-delivery/EmployeeShopPicker';
import { EmployeeDeliveryReview } from './features/employee-delivery/EmployeeDeliveryReview';
import { useEmployeeDeliveryData } from './features/employee-delivery/useEmployeeDeliveryData';

export interface EmployeeDeliveryPayload {
  roundStopId: string;
  items: Array<{ ice_type_id: string; quantity: number }>;
  status: Exclude<ShopRoundStatus, 'pending'>;
  note: string | null;
  clientRecordedAt: string;
  idempotencyKey: string;
}

export interface EmployeeStockTransferPayload {
  roundId: string;
  items: Array<{ ice_type_id: string; quantity: number }>;
  idempotencyKey: string;
}

export interface EmployeeDeliveryGateway {
  loadReferenceData(): Promise<{ rounds: DeliveryRound[]; iceTypes: IceTypeOption[] }>;
  loadShopCards(roundId: string): Promise<ShopCard[]>;
  loadEmployeeStockState(roundId: string): Promise<EmployeeStockState>;
  recordEmployeeStockTransfer(payload: EmployeeStockTransferPayload): Promise<EmployeeStockState>;
  recordDelivery(payload: EmployeeDeliveryPayload): Promise<void>;
}

export interface EmployeeDeliveryDraftState {
  dirty: boolean;
  submitting: boolean;
}

function createSupabaseGateway(): EmployeeDeliveryGateway {
  return {
    async loadReferenceData() {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const [roundsResponse, iceTypesResponse] = await Promise.all([
        supabase
          .from('delivery_rounds')
          .select('id, service_date, name, status, opened_at')
          .order('service_date', { ascending: false })
          .order('opened_at', { ascending: false }),
        supabase
          .from('ice_types')
          .select('id, code, name, unit')
          .eq('is_active', true)
          .order('code'),
      ]);
      if (roundsResponse.error) throw roundsResponse.error;
      if (iceTypesResponse.error) throw iceTypesResponse.error;
      return {
        rounds: (roundsResponse.data ?? []) as DeliveryRound[],
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
      const { error } = await supabase.rpc('record_delivery', {
        p_round_stop_id: payload.roundStopId,
        p_items: payload.items,
        p_stop_status: payload.status,
        p_note: payload.note,
        p_client_recorded_at: payload.clientRecordedAt,
        p_idempotency_key: payload.idempotencyKey,
      });
      if (error) throw error;
    },
  };
}

const productionGateway = createSupabaseGateway();

export function EmployeeDeliveryWorkspace({
  gateway = productionGateway,
  enableAssignedStockFlow = false,
  onDraftStateChange,
  requestScope = 'default',
  stockSourceLabel = 'รถ',
}: {
  gateway?: EmployeeDeliveryGateway;
  enableAssignedStockFlow?: boolean;
  onDraftStateChange?: (state: EmployeeDeliveryDraftState) => void;
  requestScope?: string;
  stockSourceLabel?: string;
}) {
  const data = useEmployeeDeliveryData({
    gateway,
    enableAssignedStockFlow,
    requestScope,
    stockSourceLabel,
    onDraftStateChange,
  });

  if (data.loadingReference) {
    return <EmployeeState title="กำลังโหลดงานวันนี้" detail="ดึงรอบส่งและชนิดน้ำแข็ง" />;
  }

  if (!data.error && data.iceTypes.length === 0) {
    return <EmployeeState title="ยังไม่มีชนิดน้ำแข็งที่ใช้งาน" detail="ให้แอดมินเปิดใช้งานชนิดน้ำแข็งอย่างน้อย 1 รายการก่อนบันทึกส่ง" />;
  }

  if (data.selectedCard && data.selectedRound) {
    return (
      <EmployeeDeliveryReview
        assignedStockState={enableAssignedStockFlow ? data.stockState : null}
        deliveryQuantities={data.deliveryQuantities}
        enableAssignedStockFlow={enableAssignedStockFlow}
        entryError={data.entryError}
        iceTypes={data.iceTypes}
        items={data.items}
        note={data.note}
        onBack={data.attemptBack}
        onChooseProblemStatus={data.chooseProblemStatus}
        onDeliveryQuantityChange={data.changeDeliveryQuantity}
        onNoteChange={data.setNote}
        onReturnToDelivery={data.returnToDelivery}
        onSubmit={data.handleSubmit}
        problemOpen={data.problemOpen}
        round={data.selectedRound}
        shopCard={data.selectedCard}
        status={data.status}
        stockSourceLabel={stockSourceLabel}
        submitting={data.submitting}
      />
    );
  }

  return (
    <div className="employee-workspace">
      <section className="employee-intro">
        <div>
          <p className="employee-eyebrow">งานพนักงาน</p>
          <h1>{enableAssignedStockFlow ? 'รับน้ำแข็ง แล้วไปส่งร้าน' : `หยิบจาก${stockSourceLabel} แล้วเลือกร้าน`}</h1>
          <p>{enableAssignedStockFlow
            ? 'รับน้ำแข็งจากรถเข้าจุดถือครองของคุณ แล้วเลือกร้านที่จะส่ง'
            : 'ทำ 2 อย่างตามลำดับ ระบบจะบันทึกยอดสต๊อกและร้านปลายทางพร้อมกัน'}</p>
        </div>
        {data.selectedRound ? (
          <div className={`employee-round-badge ${data.selectedRound.status === 'closed' ? 'employee-round-badge--closed' : ''}`}>
            <strong>{data.selectedRound.name}</strong>
            <span>{data.selectedRound.service_date} · {data.selectedRound.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}</span>
          </div>
        ) : null}
      </section>

      <section className="employee-filters employee-filters--round" aria-label="เลือกรอบส่ง">
        <label className="employee-round-select">
          <span>รอบส่ง</span>
          <select disabled={data.anySubmitting} value={data.selectedRoundId} onChange={(event) => data.chooseRound(event.target.value)}>
            <option value="">เลือกรอบส่ง</option>
            {data.rounds.map((round) => (
              <option key={round.id} value={round.id}>
                {round.name} · {round.service_date} · {round.status === 'open' ? 'เปิด' : 'ปิด'}
              </option>
            ))}
          </select>
        </label>
      </section>

      {data.success ? <p aria-live="polite" className="employee-success"><CheckCircle aria-hidden="true" size={22} weight="fill" />{data.success}</p> : null}
      {data.error ? (
        <div className="employee-error employee-error--retry" role="alert">
          <span><WarningCircle aria-hidden="true" size={22} weight="fill" />{data.error}</span>
          <button disabled={data.loadingCards || data.loadingReference} onClick={data.retryLoad} type="button">ลองใหม่</button>
        </div>
      ) : null}

      <EmployeeStockTransferSection
        enableAssignedStockFlow={enableAssignedStockFlow}
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
        stockSourceLabel={stockSourceLabel}
        selectedIceTypeId={data.selectedIceTypeId}
        setSelectedIceTypeId={data.setSelectedIceTypeId}
        submitting={data.submitting}
        deliveryQuantities={data.deliveryQuantities}
        setPadValue={data.setPadValue}
        padValues={data.PAD_VALUES}
        items={data.items}
      />

      <EmployeeShopPicker
        enableAssignedStockFlow={enableAssignedStockFlow}
        items={data.items}
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
        iceTypes={data.iceTypes}
      />
    </div>
  );
}

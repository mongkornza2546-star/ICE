import { IceCream, Truck, WarningCircle, CaretRight } from '@phosphor-icons/react';
import type { DeliveryRound, EmployeeStockState, IceTypeOption } from '../../types/app';
import { EmployeeState } from './EmployeeState';
import { QuantityStepper } from './QuantityStepper';
import { renderTotals, stockQuantity, toTotals } from './utils';

export function EmployeeStockTransferSection({
  enableAssignedStockFlow,
  stockError,
  transferSubmitting,
  loadStockState,
  selectedRoundId,
  stockState,
  iceTypes,
  transferQuantities,
  changeTransferQuantity,
  selectedRound,
  handleStockTransfer,
  transferItems,
  stockSourceLabel,
  selectedIceTypeId,
  setSelectedIceTypeId,
  submitting,
  deliveryQuantities,
  setPadValue,
  padValues,
  items,
}: {
  enableAssignedStockFlow: boolean;
  stockError: string | null;
  transferSubmitting: boolean;
  loadStockState: (roundId: string) => void;
  selectedRoundId: string;
  stockState: EmployeeStockState | null;
  iceTypes: IceTypeOption[];
  transferQuantities: Record<string, number>;
  changeTransferQuantity: (iceTypeId: string, delta: number) => void;
  selectedRound: DeliveryRound | null;
  handleStockTransfer: () => void;
  transferItems: Array<{ ice_type_id: string; quantity: number }>;
  stockSourceLabel: string;
  selectedIceTypeId: string;
  setSelectedIceTypeId: (id: string) => void;
  submitting: boolean;
  deliveryQuantities: Record<string, number>;
  setPadValue: (value: '0' | '1' | '2' | '3' | '4' | '5' | '+') => void;
  padValues: readonly ('0' | '1' | '2' | '3' | '4' | '5' | '+')[];
  items: Array<{ ice_type_id: string; quantity: number }>;
}) {
  if (enableAssignedStockFlow) {
    return (
      <section className="employee-entry-section employee-task-section" aria-labelledby="employee-stock-step">
        <div className="employee-entry-section__heading">
          <span>1</span>
          <div>
            <h2 id="employee-stock-step">รับน้ำแข็งเข้าจุดถือครอง</h2>
            <p>รับจากรถเพิ่มได้หลายครั้ง แต่ละครั้งเป็นรายการโอนใหม่</p>
          </div>
        </div>
        {stockError ? (
          <div className="employee-error employee-error--retry" role="alert">
            <span><WarningCircle aria-hidden="true" size={22} weight="fill" />{stockError}</span>
            <button disabled={transferSubmitting} onClick={() => void loadStockState(selectedRoundId)} type="button">ลองใหม่</button>
          </div>
        ) : null}
        {!selectedRoundId ? (
          <EmployeeState title="เลือกรอบส่งก่อน" detail="ระบบจะหาจุดถือครองที่ผูกกับคุณให้อัตโนมัติ" />
        ) : !stockState && !stockError ? (
          <EmployeeState title="กำลังโหลดสต๊อกของคุณ" detail="ตรวจยอดรถและจุดถือครอง" />
        ) : stockState ? (
          <>
            <div className="employee-stock-route">
              <span><Truck aria-hidden="true" size={22} />{stockState.truck_location.name}</span>
              <CaretRight aria-hidden="true" size={20} />
              <strong>{stockState.holding_location.name}</strong>
            </div>
            <div className="employee-stock-table" role="table" aria-label="ยอดก่อนและหลังรับน้ำแข็ง">
              <div className="employee-stock-row employee-stock-row--header" role="row">
                <span role="columnheader">ชนิด</span><span role="columnheader">รถก่อน</span><span role="columnheader">รับเพิ่ม</span><span role="columnheader">รถหลัง</span><span role="columnheader">จุดก่อน</span><span role="columnheader">จุดหลัง</span>
              </div>
              {iceTypes.map((iceType) => {
                const truckBefore = stockQuantity(stockState.truck_location.balances, iceType.id);
                const holdingBefore = stockQuantity(stockState.holding_location.balances, iceType.id);
                const transferQuantity = transferQuantities[iceType.id] ?? 0;
                return (
                  <div className="employee-stock-row" key={iceType.id} role="row">
                    <strong role="cell">{iceType.name}<small>{iceType.unit}</small></strong>
                    <span data-label="รถก่อน" role="cell">{truckBefore}</span>
                    <div className="employee-stock-transfer-cell" data-label="รับเพิ่ม" role="cell">
                      <QuantityStepper
                        disabled={transferSubmitting || selectedRound?.status === 'closed'}
                        iceTypeName={iceType.name}
                        maxQuantity={truckBefore}
                        onChange={(delta) => changeTransferQuantity(iceType.id, delta)}
                        quantity={transferQuantity}
                        purpose="รับเพิ่ม"
                      />
                    </div>
                    <span data-label="รถหลัง" role="cell">{truckBefore - transferQuantity}</span>
                    <span data-label="จุดก่อน" role="cell">{holdingBefore}</span>
                    <b data-label="จุดหลัง" role="cell">{holdingBefore + transferQuantity}</b>
                  </div>
                );
              })}
            </div>
            <button
              className="employee-submit employee-stock-submit"
              disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
              onClick={() => void handleStockTransfer()}
              type="button"
            >
              {selectedRound?.status === 'closed' ? 'รอบนี้ปิดแล้ว' : transferSubmitting ? 'กำลังบันทึก...' : 'ยืนยันรับน้ำแข็ง'}
            </button>
          </>
        ) : null}
      </section>
    );
  }

  return (
    <section className="employee-entry-section employee-task-section" aria-labelledby="employee-stock-step">
      <div className="employee-entry-section__heading">
        <span>1</span>
        <div>
          <h2 id="employee-stock-step">น้ำแข็งออกจาก{stockSourceLabel}</h2>
          <p>เลือกชนิด แล้วใส่จำนวนที่หยิบจากสต๊อก{stockSourceLabel}</p>
        </div>
      </div>
      <div className="employee-ice-grid">
        {iceTypes.map((iceType) => {
          const selected = selectedIceTypeId === iceType.id;
          return (
            <button
              aria-pressed={selected}
              className={`employee-ice-button ${selected ? 'employee-ice-button--selected' : ''}`}
              disabled={!selectedRoundId || submitting || selectedRound?.status === 'closed'}
              key={iceType.id}
              onClick={() => setSelectedIceTypeId(iceType.id)}
              type="button"
            >
              <IceCream aria-hidden="true" size={27} />
              <span>{iceType.name}</span>
              <strong>{deliveryQuantities[iceType.id] ?? 0}</strong>
              <small>{iceType.unit}</small>
            </button>
          );
        })}
      </div>
      <div className="employee-number-pad" aria-label="ปุ่มจำนวน">
        {padValues.map((value) => (
          <button
            aria-label={value === '+' ? 'เพิ่มอีกหนึ่ง' : `ตั้งจำนวนเป็น ${value}`}
            disabled={!selectedRoundId || !selectedIceTypeId || submitting || selectedRound?.status === 'closed'}
            key={value}
            onClick={() => setPadValue(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
      <div className={`employee-task-summary ${items.length > 0 ? 'employee-task-summary--ready' : ''}`} aria-live="polite">
        <Truck aria-hidden="true" size={24} />
        <span>ยอดออกจาก{stockSourceLabel}</span>
        <strong>{items.length > 0 ? renderTotals(toTotals(items), iceTypes) : 'ยังไม่ได้ใส่จำนวน'}</strong>
      </div>
    </section>
  );
}

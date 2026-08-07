import { ArrowClockwise, Check, Truck, WarningCircle, CaretRight } from '@phosphor-icons/react';
import type { DeliveryRound, EmployeeStockState, IceTypeOption } from '../../types/app';
import { EmployeeState } from './EmployeeState';
import { QuantityStepper } from './QuantityStepper';
import { stockQuantity } from './utils';

export function EmployeeStockTransferSection({
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
  resetTransferQuantities,
  variant,
  transferItems,
}: {
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
  resetTransferQuantities: () => void;
  variant: 'cards' | 'table';
  transferItems: Array<{ ice_type_id: string; quantity: number }>;
}) {
  const isCardLayout = variant === 'cards';

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
            {isCardLayout ? (
              <div className="employee-stock-route">
                <Truck aria-hidden="true" size={28} weight="duotone" />
                <span>
                  <small>{stockState.truck_location.name}</small>
                  <strong>{stockState.holding_location.name}</strong>
                </span>
                <CaretRight aria-hidden="true" size={20} weight="bold" />
              </div>
            ) : (
              <div className="employee-stock-route">
                <span><Truck aria-hidden="true" size={22} />{stockState.truck_location.name}</span>
                <CaretRight aria-hidden="true" size={20} />
                <strong>{stockState.holding_location.name}</strong>
              </div>
            )}
            {isCardLayout ? (
              <div className="employee-stock-table" role="list" aria-label="ยอดก่อนและหลังรับน้ำแข็ง">
                {iceTypes.map((iceType) => {
                  const truckBefore = stockQuantity(stockState.truck_location.balances, iceType.id);
                  const holdingBefore = stockQuantity(stockState.holding_location.balances, iceType.id);
                  const transferQuantity = transferQuantities[iceType.id] ?? 0;
                  return (
                    <div className="employee-stock-row" key={iceType.id} role="listitem">
                      <strong><span>{iceType.name}</span> <small>({iceType.unit})</small></strong>
                      <span className="employee-stock-available"><small>รถก่อน</small>{truckBefore} {iceType.unit}</span>
                      {iceType.image_url ? (
                        <img alt="" aria-hidden="true" className="employee-stock-product-image" loading="lazy" src={iceType.image_url} />
                      ) : null}
                      <div className="employee-stock-transfer-cell">
                        <QuantityStepper
                          disabled={transferSubmitting || selectedRound?.status === 'closed'}
                          iceTypeName={iceType.name}
                          maxQuantity={truckBefore}
                          onChange={(delta) => changeTransferQuantity(iceType.id, delta)}
                          quantity={transferQuantity}
                          purpose="รับเพิ่ม"
                          unit={iceType.unit}
                        />
                      </div>
                      <div className="employee-stock-stats" role="group" aria-label={`ยอด${iceType.name}`}>
                        <span><small>รถหลัง</small><strong>{truckBefore - transferQuantity}</strong> {iceType.unit}</span>
                        <span><small>จุดก่อน</small><strong>{holdingBefore}</strong> {iceType.unit}</span>
                        <span><small>จุดหลัง</small><strong>{holdingBefore + transferQuantity}</strong> {iceType.unit}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
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
            )}
            {isCardLayout ? (
              <div className="employee-stock-actions">
                <button
                  className="employee-stock-reset"
                  disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                  onClick={resetTransferQuantities}
                  type="button"
                >
                  <ArrowClockwise aria-hidden="true" size={20} weight="bold" />
                  รีเซ็ตทั้งหมด
                </button>
                <button
                  aria-label="ยืนยันรับน้ำแข็ง"
                  className="employee-submit employee-stock-submit"
                  disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                  onClick={() => void handleStockTransfer()}
                  type="button"
                >
                  <Check aria-hidden="true" size={22} weight="bold" />
                  {selectedRound?.status === 'closed' ? 'รอบนี้ปิดแล้ว' : transferSubmitting ? 'กำลังบันทึก...' : 'ยืนยันการเบิก'}
                </button>
              </div>
            ) : (
              <button
                className="employee-submit employee-stock-submit"
                disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                onClick={() => void handleStockTransfer()}
                type="button"
              >
                {selectedRound?.status === 'closed' ? 'รอบนี้ปิดแล้ว' : transferSubmitting ? 'กำลังบันทึก...' : 'ยืนยันรับน้ำแข็ง'}
              </button>
            )}
          </>
        ) : null}
    </section>
  );
}

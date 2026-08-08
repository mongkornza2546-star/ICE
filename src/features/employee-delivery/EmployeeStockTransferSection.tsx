import { useEffect, useState } from 'react';
import { ArrowClockwise, Check, Truck, WarningCircle, CaretRight, X } from '@phosphor-icons/react';
import type { DeliveryRound, EmployeeStockState, IceTypeOption } from '../../types/app';
import type { StockTransferMode } from './useEmployeeDeliveryData';
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
  stockTransferMode,
  changeStockTransferMode,
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
  stockTransferMode: StockTransferMode;
  changeStockTransferMode: (mode: StockTransferMode) => void;
  selectedRound: DeliveryRound | null;
  handleStockTransfer: () => void;
  resetTransferQuantities: () => void;
  variant: 'cards' | 'table';
  transferItems: Array<{ ice_type_id: string; quantity: number }>;
}) {
  const isCardLayout = variant === 'cards';
  const isReturn = stockTransferMode === 'return';
  const movementLabel = isReturn ? 'คืนขึ้นรถ' : 'รับเพิ่ม';
  const [previewImage, setPreviewImage] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    if (!previewImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewImage]);

  return (
    <section className="employee-entry-section employee-task-section" aria-labelledby="employee-stock-step">
        <div className="employee-entry-section__heading">
          <span>1</span>
          <div>
            <h2 id="employee-stock-step">{isReturn ? 'คืนน้ำแข็งขึ้นรถ' : 'รับน้ำแข็งเข้าจุดถือครอง'}</h2>
            <p>{isReturn
              ? 'คืนของที่เหลือจากจุดถือครองกลับขึ้นรถ'
              : 'รับจากรถเพิ่มได้หลายครั้ง แต่ละครั้งเป็นรายการโอนใหม่'}</p>
          </div>
        </div>
        <div aria-label="เลือกประเภทรายการสต๊อก" className="employee-stock-mode" role="group">
          <button
            aria-pressed={!isReturn}
            disabled={transferSubmitting}
            onClick={() => changeStockTransferMode('receive')}
            type="button"
          >เบิกจากรถ</button>
          <button
            aria-pressed={isReturn}
            disabled={transferSubmitting}
            onClick={() => changeStockTransferMode('return')}
            type="button"
          >คืนขึ้นรถ</button>
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
                  <small>{isReturn ? stockState.holding_location.name : stockState.truck_location.name}</small>
                  <strong>{isReturn ? stockState.truck_location.name : stockState.holding_location.name}</strong>
                </span>
                <CaretRight aria-hidden="true" size={20} weight="bold" />
              </div>
            ) : (
              <div className="employee-stock-route">
                <span><Truck aria-hidden="true" size={22} />{isReturn ? stockState.holding_location.name : stockState.truck_location.name}</span>
                <CaretRight aria-hidden="true" size={20} />
                <strong>{isReturn ? stockState.truck_location.name : stockState.holding_location.name}</strong>
              </div>
            )}
            {isCardLayout ? (
              <div className="employee-stock-table" role="list" aria-label={isReturn ? 'ยอดก่อนและหลังคืนน้ำแข็ง' : 'ยอดเบิกและยอดควรเหลือ'}>
                {iceTypes.map((iceType) => {
                  const truckBefore = stockQuantity(stockState.truck_location.balances, iceType.id);
                  const holdingBefore = stockQuantity(stockState.holding_location.balances, iceType.id);
                  const withdrawnToday = stockQuantity(stockState.withdrawn_balances, iceType.id);
                  const transferQuantity = transferQuantities[iceType.id] ?? 0;
                  return (
                    <div className="employee-stock-row" key={iceType.id} role="listitem">
                      <strong><span>{iceType.name}</span> <small>({iceType.unit})</small></strong>
                      <span className="employee-stock-available"><small>{isReturn ? 'เหลือก่อนคืน' : 'เหลือบนรถ'}</small>{isReturn ? holdingBefore : truckBefore} {iceType.unit}</span>
                      {iceType.image_url ? (
                        <button
                          aria-label={`ดูรูป ${iceType.name} ขนาดใหญ่`}
                          className="employee-stock-product-image-button"
                          onClick={() => setPreviewImage({ name: iceType.name, url: iceType.image_url! })}
                          type="button"
                        >
                          <img alt={iceType.name} className="employee-stock-product-image" loading="lazy" src={iceType.image_url} />
                        </button>
                      ) : null}
                      <div className="employee-stock-transfer-cell">
                        <QuantityStepper
                          disabled={transferSubmitting || selectedRound?.status === 'closed'}
                          iceTypeName={iceType.name}
                          maxQuantity={isReturn ? holdingBefore : truckBefore}
                          onChange={(delta) => changeTransferQuantity(iceType.id, delta)}
                          quantity={transferQuantity}
                          purpose={movementLabel}
                          unit={iceType.unit}
                        />
                      </div>
                      <div className="employee-stock-stats" role="group" aria-label={`ยอด${iceType.name}`}>
                        {isReturn ? (
                          <>
                            <span><small>รถก่อน</small><strong>{truckBefore}</strong> {iceType.unit}</span>
                            <span><small>เหลือหลังคืน</small><strong>{holdingBefore - transferQuantity}</strong> {iceType.unit}</span>
                          </>
                        ) : (
                          <>
                            <span><small>เบิกวันนี้</small><strong>{withdrawnToday}</strong> {iceType.unit}</span>
                            <span><small>ควรเหลือ</small><strong>{holdingBefore}</strong> {iceType.unit}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="employee-stock-table" role="table" aria-label={isReturn ? 'ยอดก่อนและหลังคืนน้ำแข็ง' : 'ยอดเบิกและยอดควรเหลือ'}>
                <div className="employee-stock-row employee-stock-row--header" role="row">
                  <span role="columnheader">ชนิด</span><span role="columnheader">{isReturn ? 'เหลือก่อนคืน' : 'เหลือบนรถ'}</span><span role="columnheader">{movementLabel}</span><span role="columnheader">{isReturn ? 'รถก่อน' : 'เบิกวันนี้'}</span><span role="columnheader">{isReturn ? 'เหลือหลังคืน' : 'ควรเหลือ'}</span>
                </div>
                {iceTypes.map((iceType) => {
                  const truckBefore = stockQuantity(stockState.truck_location.balances, iceType.id);
                  const holdingBefore = stockQuantity(stockState.holding_location.balances, iceType.id);
                  const withdrawnToday = stockQuantity(stockState.withdrawn_balances, iceType.id);
                  const transferQuantity = transferQuantities[iceType.id] ?? 0;
                  return (
                    <div className="employee-stock-row" key={iceType.id} role="row">
                      <strong role="cell">{iceType.name}<small>{iceType.unit}</small></strong>
                      <span data-label={isReturn ? 'เหลือก่อนคืน' : 'เหลือบนรถ'} role="cell">{isReturn ? holdingBefore : truckBefore}</span>
                      <div className="employee-stock-transfer-cell" data-label={movementLabel} role="cell">
                        <QuantityStepper
                          disabled={transferSubmitting || selectedRound?.status === 'closed'}
                          iceTypeName={iceType.name}
                          maxQuantity={isReturn ? holdingBefore : truckBefore}
                          onChange={(delta) => changeTransferQuantity(iceType.id, delta)}
                          quantity={transferQuantity}
                          purpose={movementLabel}
                        />
                      </div>
                      <span data-label={isReturn ? 'รถก่อน' : 'เบิกวันนี้'} role="cell">{isReturn ? truckBefore : withdrawnToday}</span>
                      <b data-label={isReturn ? 'เหลือหลังคืน' : 'ควรเหลือ'} role="cell">{isReturn ? holdingBefore - transferQuantity : holdingBefore}</b>
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
                  aria-label={isReturn ? 'ยืนยันคืนของ' : 'ยืนยันรับน้ำแข็ง'}
                  className="employee-submit employee-stock-submit"
                  disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                  onClick={() => void handleStockTransfer()}
                  type="button"
                >
                  <Check aria-hidden="true" size={22} weight="bold" />
                  {selectedRound?.status === 'closed' ? 'รอบนี้ปิดแล้ว' : transferSubmitting ? 'กำลังบันทึก...' : isReturn ? 'ยืนยันคืนของ' : 'ยืนยันการเบิก'}
                </button>
              </div>
            ) : (
              <button
                className="employee-submit employee-stock-submit"
                disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                onClick={() => void handleStockTransfer()}
                type="button"
              >
                {selectedRound?.status === 'closed' ? 'รอบนี้ปิดแล้ว' : transferSubmitting ? 'กำลังบันทึก...' : isReturn ? 'ยืนยันคืนของ' : 'ยืนยันรับน้ำแข็ง'}
              </button>
            )}
          </>
        ) : null}
        {previewImage ? (
          <div className="image-preview-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null);
          }} role="presentation">
            <section aria-labelledby="employee-stock-image-preview-title" aria-modal="true" className="image-preview-dialog" role="dialog">
              <div className="image-preview-dialog__header">
                <h2 id="employee-stock-image-preview-title">รูป {previewImage.name}</h2>
                <button aria-label="ปิดรูปภาพ" className="image-preview-dialog__close" onClick={() => setPreviewImage(null)} type="button">
                  <X size={22} weight="bold" />
                </button>
              </div>
              <img alt={previewImage.name} className="image-preview-dialog__image" src={previewImage.url} />
            </section>
          </div>
        ) : null}
    </section>
  );
}

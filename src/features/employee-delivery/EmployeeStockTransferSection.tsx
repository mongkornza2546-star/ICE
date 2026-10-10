import { translateUi, useLanguage } from '../../i18n';
import { useEffect, useState } from 'react';
import { ArrowClockwise, Check, Truck, WarningCircle, CaretRight, X } from '@phosphor-icons/react';
import type { DeliveryRound, EmployeeStockState, IceTypeOption } from '../../types/app';
import type { StockTransferMode } from './useEmployeeDeliveryData';
import { EmployeeState } from './EmployeeState';
import { EmployeeStockProductImage } from './EmployeeStockProductImage';
import './employee-stock-product-image.css';
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
  useLanguage();
  const isCardLayout = variant === 'cards';
  const isReturn = stockTransferMode === 'return';
  const isDamage = stockTransferMode === 'damage';
  const usesHoldingStock = isReturn || isDamage;
  const movementLabel = isReturn ? 'คืนขึ้นรถ' : isDamage ? 'ละลาย' : 'เติมจากรถ';
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
            <h2 id="employee-stock-step">{isReturn ? translateUi('คืนน้ำแข็งขึ้นรถ') : isDamage ? translateUi('บันทึกน้ำแข็งละลาย') : translateUi('เติมน้ำแข็งเข้าจุดถือครอง')}</h2>
            <p>{isReturn
              ? translateUi('คืนของที่เหลือจากจุดถือครองกลับขึ้นรถ')
              : isDamage
                ? translateUi('ตัดออกจากสต๊อกที่คุณถือเมื่อสินค้าเสียหายหรือละลาย')
                : translateUi('เติมจากรถเพิ่มได้หลายครั้ง แต่ละครั้งเป็นรายการโอนใหม่')}</p>
          </div>
        </div>
        <div aria-label={translateUi('เลือกประเภทรายการสต๊อก')} className="employee-stock-mode" role="group">
          <button
            aria-pressed={stockTransferMode === 'receive'}
            disabled={transferSubmitting}
            onClick={() => changeStockTransferMode('receive')}
            type="button"
          >{translateUi('เติมจากรถ')}</button>
          <button
            aria-pressed={isReturn}
            disabled={transferSubmitting}
            onClick={() => changeStockTransferMode('return')}
            type="button"
          >{translateUi('คืนขึ้นรถ')}</button>
          <button
            aria-pressed={isDamage}
            disabled={transferSubmitting}
            onClick={() => changeStockTransferMode('damage')}
            type="button"
          >{translateUi('ละลาย')}</button>
        </div>
        {stockError ? (
          <div className="employee-error employee-error--retry" role="alert">
            <span><WarningCircle aria-hidden="true" size={22} weight="fill" />{translateUi(stockError)}</span>
            <button disabled={transferSubmitting} onClick={() => void loadStockState(selectedRoundId)} type="button">{translateUi('ลองใหม่')}</button>
          </div>
        ) : null}
        {!selectedRoundId ? (
          <EmployeeState title={translateUi('เลือกรอบส่งก่อน')} detail={translateUi('ระบบจะหาจุดถือครองที่ผูกกับคุณให้อัตโนมัติ')} />
        ) : !stockState && !stockError ? (
          <EmployeeState title={translateUi('กำลังโหลดสต๊อกของคุณ')} detail={translateUi('ตรวจยอดรถและจุดถือครอง')} />
        ) : stockState ? (
          <>
            {isCardLayout ? (
              <div className="employee-stock-route">
                <Truck aria-hidden="true" size={28} weight="duotone" />
                <span>
                  <small>{usesHoldingStock ? stockState.holding_location.name : stockState.truck_location.name}</small>
                  <strong>{isDamage ? translateUi('ตัดออกจากสต๊อก') : isReturn ? stockState.truck_location.name : stockState.holding_location.name}</strong>
                </span>
                <CaretRight aria-hidden="true" size={20} weight="bold" />
              </div>
            ) : (
              <div className="employee-stock-route">
                <span><Truck aria-hidden="true" size={22} />{usesHoldingStock ? stockState.holding_location.name : stockState.truck_location.name}</span>
                <CaretRight aria-hidden="true" size={20} />
                <strong>{isDamage ? translateUi('ตัดออกจากสต๊อก') : isReturn ? stockState.truck_location.name : stockState.holding_location.name}</strong>
              </div>
            )}
            {isCardLayout ? (
              <div className="employee-stock-table" role="list" aria-label={isReturn ? translateUi('ยอดก่อนและหลังคืนน้ำแข็ง') : isDamage ? translateUi('ยอดก่อนและหลังบันทึกน้ำแข็งละลาย') : translateUi('ยอดเติมและยอดควรเหลือ')}>
                {iceTypes.map((iceType) => {
                  const truckBefore = stockQuantity(stockState.truck_location.balances, iceType.id);
                  const holdingBefore = stockQuantity(stockState.holding_location.balances, iceType.id);
                  const withdrawnToday = stockQuantity(stockState.withdrawn_balances, iceType.id);
                  const transferQuantity = transferQuantities[iceType.id] ?? 0;
                  return (
                    <div className="employee-stock-row" key={iceType.id} role="listitem">
                      <strong><span>{iceType.name}</span> <small>({iceType.unit})</small></strong>
                      <span className="employee-stock-available"><small>{usesHoldingStock ? isDamage ? translateUi('เหลือก่อนละลาย') : translateUi('เหลือก่อนคืน') : translateUi('เหลือบนรถ')}</small>{usesHoldingStock ? holdingBefore : truckBefore} {iceType.unit}</span>
                      {iceType.image_url || iceType.image_path ? (
                        <EmployeeStockProductImage
                          key={`${iceType.id}:${iceType.image_path}:${iceType.image_url}`}
                          iceType={iceType}
                          onPreview={setPreviewImage}
                        />
                      ) : null}
                      <div className="employee-stock-transfer-cell">
                        <QuantityStepper
                          disabled={transferSubmitting || selectedRound?.status === 'closed'}
                          iceTypeName={iceType.name}
                          maxQuantity={usesHoldingStock ? holdingBefore : truckBefore}
                          onChange={(delta) => changeTransferQuantity(iceType.id, delta)}
                          quantity={transferQuantity}
                          purpose={movementLabel}
                          step={0.5}
                          unit={iceType.unit}
                        />
                      </div>
                      <div className="employee-stock-stats" role="group" aria-label={translateUi('ยอด{0}', { 0: iceType.name })}>
                        {isReturn ? (
                          <>
                            <span><small>{translateUi('รถก่อน')}</small><strong>{truckBefore}</strong> {iceType.unit}</span>
                            <span><small>{translateUi('เหลือหลังคืน')}</small><strong>{holdingBefore - transferQuantity}</strong> {iceType.unit}</span>
                          </>
                        ) : isDamage ? (
                          <>
                            <span><small>{translateUi('คงเหลือก่อน')}</small><strong>{holdingBefore}</strong> {iceType.unit}</span>
                            <span><small>{translateUi('เหลือหลังละลาย')}</small><strong>{holdingBefore - transferQuantity}</strong> {iceType.unit}</span>
                          </>
                        ) : (
                          <>
                            <span><small>{translateUi('เติมวันนี้')}</small><strong>{withdrawnToday}</strong> {iceType.unit}</span>
                            <span><small>{translateUi('ควรเหลือ')}</small><strong>{holdingBefore}</strong> {iceType.unit}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="employee-stock-table" role="table" aria-label={isReturn ? translateUi('ยอดก่อนและหลังคืนน้ำแข็ง') : isDamage ? translateUi('ยอดก่อนและหลังบันทึกน้ำแข็งละลาย') : translateUi('ยอดเติมและยอดควรเหลือ')}>
                <div className="employee-stock-row employee-stock-row--header" role="row">
                  <span role="columnheader">{translateUi('ชนิด')}</span><span role="columnheader">{usesHoldingStock ? isDamage ? translateUi('เหลือก่อนละลาย') : translateUi('เหลือก่อนคืน') : translateUi('เหลือบนรถ')}</span><span role="columnheader">{translateUi(movementLabel)}</span><span role="columnheader">{isReturn ? translateUi('รถก่อน') : isDamage ? translateUi('คงเหลือก่อน') : translateUi('เติมวันนี้')}</span><span role="columnheader">{usesHoldingStock ? isDamage ? translateUi('เหลือหลังละลาย') : translateUi('เหลือหลังคืน') : translateUi('ควรเหลือ')}</span>
                </div>
                {iceTypes.map((iceType) => {
                  const truckBefore = stockQuantity(stockState.truck_location.balances, iceType.id);
                  const holdingBefore = stockQuantity(stockState.holding_location.balances, iceType.id);
                  const withdrawnToday = stockQuantity(stockState.withdrawn_balances, iceType.id);
                  const transferQuantity = transferQuantities[iceType.id] ?? 0;
                  return (
                    <div className="employee-stock-row" key={iceType.id} role="row">
                      <strong role="cell">{iceType.name}<small>{iceType.unit}</small></strong>
                      <span data-label={usesHoldingStock ? isDamage ? translateUi('เหลือก่อนละลาย') : translateUi('เหลือก่อนคืน') : translateUi('เหลือบนรถ')} role="cell">{usesHoldingStock ? holdingBefore : truckBefore}</span>
                      <div className="employee-stock-transfer-cell" data-label={translateUi(movementLabel)} role="cell">
                        <QuantityStepper
                          disabled={transferSubmitting || selectedRound?.status === 'closed'}
                          iceTypeName={iceType.name}
                          maxQuantity={usesHoldingStock ? holdingBefore : truckBefore}
                          onChange={(delta) => changeTransferQuantity(iceType.id, delta)}
                          quantity={transferQuantity}
                          purpose={movementLabel}
                          step={0.5}
                        />
                      </div>
                      <span data-label={isReturn ? translateUi('รถก่อน') : isDamage ? translateUi('คงเหลือก่อน') : translateUi('เติมวันนี้')} role="cell">{isReturn ? truckBefore : isDamage ? holdingBefore : withdrawnToday}</span>
                      <b data-label={usesHoldingStock ? isDamage ? translateUi('เหลือหลังละลาย') : translateUi('เหลือหลังคืน') : translateUi('ควรเหลือ')} role="cell">{usesHoldingStock ? holdingBefore - transferQuantity : holdingBefore}</b>
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
                  {translateUi('รีเซ็ตทั้งหมด')}</button>
                <button
                  aria-label={isReturn ? translateUi('ยืนยันคืนของ') : isDamage ? translateUi('ยืนยันน้ำแข็งละลาย') : translateUi('ยืนยันเติมน้ำแข็ง')}
                  className="employee-submit employee-stock-submit"
                  disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                  onClick={() => void handleStockTransfer()}
                  type="button"
                >
                  <Check aria-hidden="true" size={22} weight="bold" />
                  {selectedRound?.status === 'closed' ? translateUi('รอบนี้ปิดแล้ว') : transferSubmitting ? translateUi('กำลังบันทึก...') : isReturn ? translateUi('ยืนยันคืนของ') : isDamage ? translateUi('ยืนยันน้ำแข็งละลาย') : translateUi('ยืนยันการเติม')}
                </button>
              </div>
            ) : (
              <button
                className="employee-submit employee-stock-submit"
                disabled={transferSubmitting || transferItems.length === 0 || selectedRound?.status === 'closed'}
                onClick={() => void handleStockTransfer()}
                type="button"
              >
                {selectedRound?.status === 'closed' ? translateUi('รอบนี้ปิดแล้ว') : transferSubmitting ? translateUi('กำลังบันทึก...') : isReturn ? translateUi('ยืนยันคืนของ') : isDamage ? translateUi('ยืนยันน้ำแข็งละลาย') : translateUi('ยืนยันการเติม')}
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
                <h2 id="employee-stock-image-preview-title">{translateUi('รูป ')}{previewImage.name}</h2>
                <button aria-label={translateUi('ปิดรูปภาพ')} className="image-preview-dialog__close" onClick={() => setPreviewImage(null)} type="button">
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

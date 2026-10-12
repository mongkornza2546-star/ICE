import { localizeErrorMessage, translateUi, useLanguage } from '../../i18n';
import { useEffect, useState } from 'react';
import { ArrowClockwise, Check, Truck, WarningCircle, CaretRight, X } from '@phosphor-icons/react';
import type { DeliveryRound, EmployeeStockState, IceTypeOption } from '../../types/app';
import type { StockTransferMode, StockTransferSuccess } from './useEmployeeDeliveryData';
import { EmployeeState } from './EmployeeState';
import { EmployeeStockProductImage } from './EmployeeStockProductImage';
import './employee-stock-product-image.css';
import { bagTotal, emptyBags, formatBags, type BagQuantity } from './bagQuantity';
import './employee-bag-transfer.css';
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
  undoTransferQuantity,
  canUndo,
  success,
  variant,
  transferItems,
}: {
  stockError: string | null;
  transferSubmitting: boolean;
  loadStockState: (roundId: string) => void;
  selectedRoundId: string;
  stockState: EmployeeStockState | null;
  iceTypes: IceTypeOption[];
  transferQuantities: Record<string, BagQuantity>;
  changeTransferQuantity: (iceTypeId: string, field: keyof BagQuantity, value: number) => void;
  stockTransferMode: StockTransferMode;
  changeStockTransferMode: (mode: StockTransferMode) => void;
  selectedRound: DeliveryRound | null;
  handleStockTransfer: () => void;
  undoTransferQuantity: () => void;
  canUndo: boolean;
  success: StockTransferSuccess | null;
  variant: 'cards' | 'table';
  transferItems: Array<{ ice_type_id: string; quantity: number }>;
}) {
  useLanguage();
  const isCardLayout = variant === 'cards';
  const isReturn = stockTransferMode === 'return';
  const isDamage = stockTransferMode === 'damage';
  const usesHoldingStock = isReturn || isDamage;
  const movementLabel = isReturn ? 'คืนขึ้นรถ' : isDamage ? 'ละลาย' : 'เติมจากรถ';
  const translatedStockError = stockError ? translateUi(stockError) : null;
  const stockErrorMessage = stockError && translatedStockError === stockError
    ? localizeErrorMessage(stockError) : translatedStockError;
  const successMessage = success ? translateUi(success.mode === 'return'
    ? 'บันทึกแล้ว คืนไป {0} ถุง'
    : success.mode === 'damage' ? 'บันทึกแล้ว ละลายไป {0} ถุง' : 'บันทึกแล้ว เติมไป {0} ถุง',
  { 0: formatBags(success.quantity) }) : null;
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
            <span><WarningCircle aria-hidden="true" size={22} weight="fill" />{stockErrorMessage}</span>
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
            <div className="bag-transfer-list" role="list" aria-label={translateUi(movementLabel)}>
              {iceTypes.map((iceType) => {
                const bags = transferQuantities[iceType.id] ?? emptyBags();
                const quantity = bagTotal({ ...bags, halfBags: iceType.allowHalf === false ? 0 : bags.halfBags });
                const before = stockQuantity(usesHoldingStock ? stockState.holding_location.balances : stockState.truck_location.balances, iceType.id);
                const disabled = transferSubmitting || selectedRound?.status === 'closed';
                return <div className="bag-transfer-card" key={iceType.id} role="listitem">
                  <div className="bag-transfer-heading">
                    {iceType.image_url || iceType.image_path ? <EmployeeStockProductImage key={`${iceType.id}:${iceType.image_path}:${iceType.image_url}`} iceType={iceType} onPreview={setPreviewImage} />
                      : <span className="bag-product-fallback" aria-hidden="true">{Array.from(iceType.name).slice(0, 2).join('')}</span>}
                    <div className="bag-product-name"><strong>{iceType.name}</strong><small>{translateUi(usesHoldingStock ? 'เหลือที่ถือ {0} ถุง' : 'เหลือบนรถ {0} ถุง', { 0: formatBags(before - quantity) })}</small></div>
                    <div className="bag-transfer-total"><small>{translateUi(isReturn ? 'คืนครั้งนี้' : isDamage ? 'ละลายครั้งนี้' : 'เติมครั้งนี้')}</small><strong>{formatBags(quantity)} <small>{translateUi('ถุง')}</small></strong></div>
                  </div>
                  <div className="bag-transfer-inputs">
                    {(['fullBags', ...(iceType.allowHalf === false ? [] : ['halfBags'])] as Array<keyof BagQuantity>).map((field) => {
                      const label = translateUi(field === 'fullBags' ? 'เต็มถุง' : 'ครึ่งถุง');
                      return <label className="bag-counter" key={field}>
                        <span>{label} <small>{field === 'fullBags' ? '×1' : '×½'}</small></span>
                        <span className="bag-counter-controls">
                          <button type="button" aria-label={translateUi('ลด{0} {1}', { 0: label, 1: iceType.name })} disabled={disabled || bags[field] === 0} onClick={() => changeTransferQuantity(iceType.id, field, bags[field] - 1)}>−</button>
                          <input aria-label={`${label} ${iceType.name}`} type="text" inputMode="numeric" pattern="[0-9]*" value={bags[field]} disabled={disabled}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => {
                              if (/^[0-9]*$/.test(event.target.value)) changeTransferQuantity(iceType.id, field, Number(event.target.value));
                            }} />
                          <button type="button" aria-label={translateUi('เพิ่ม{0} {1}', { 0: label, 1: iceType.name })} disabled={disabled} onClick={() => changeTransferQuantity(iceType.id, field, bags[field] + 1)}>+</button>
                        </span>
                      </label>;
                    })}
                  </div>
                  <div className="bag-transfer-warning" role={quantity > before ? 'status' : undefined}>
                    {quantity > before ? translateUi('จำนวนเกินสต๊อกคงเหลือ ต้องยืนยันก่อนบันทึก') : '\u00a0'}
                  </div>
                </div>;
              })}
            </div>
            <div className="bag-transfer-actions">
              <div className="bag-transfer-buttons">
                <button className="bag-transfer-undo" disabled={transferSubmitting || !canUndo || selectedRound?.status === 'closed'} onClick={undoTransferQuantity} type="button">
                  <ArrowClockwise aria-hidden="true" size={18} />{translateUi('ย้อนกลับ')}
                </button>
                <button className="employee-submit" disabled={transferSubmitting || selectedRound?.status === 'closed'} onClick={() => void handleStockTransfer()} type="button">
                  <Check aria-hidden="true" size={18} />
                  {selectedRound?.status === 'closed' ? translateUi('รอบนี้ปิดแล้ว') : transferSubmitting ? translateUi('กำลังบันทึก...') : translateUi('บันทึก{0} · {1} ถุง', { 0: translateUi(movementLabel), 1: formatBags(transferItems.reduce((sum, item) => sum + item.quantity, 0)) })}
                </button>
              </div>
              {stockError ? <p className="bag-transfer-error" role="alert"><span>{stockErrorMessage}</span> <span>{translateUi('กรุณาลองบันทึกใหม่')}</span></p> : successMessage ? <p className="bag-transfer-success" role="status">{successMessage}</p> : null}
            </div>
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

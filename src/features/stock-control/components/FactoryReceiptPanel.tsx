import { useEffect, useMemo, useState } from 'react';
import { Check, Package, Snowflake } from '@phosphor-icons/react';
import type { FactoryReceiptSummary } from '../../../types/app';

interface FactoryReceiptPanelProps {
  summary: FactoryReceiptSummary | null;
  onSaveReceipt: (factoryOrderId: string, items: { ice_type_id: string; actual_quantity: number }[], note: string) => Promise<void>;
  loading: boolean;
  error: string | null;
  successMessage?: string | null;
}

export function FactoryReceiptPanel({
  summary,
  onSaveReceipt,
  loading,
  error,
  successMessage,
}: FactoryReceiptPanelProps) {
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [actualCounts, setActualCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const receipts = summary?.receipts ?? [];
  const selectedReceipt = useMemo(() => (
    receipts.find((receipt) => receipt.factory_order_id === selectedOrderId)
      ?? receipts.find((receipt) => receipt.status === 'pending')
      ?? receipts[0]
      ?? null
  ), [receipts, selectedOrderId]);
  const isRecorded = selectedReceipt?.status === 'recorded';

  useEffect(() => {
    setSelectedOrderId((current) => (
      receipts.some((receipt) => receipt.factory_order_id === current)
        ? current
        : receipts.find((receipt) => receipt.status === 'pending')?.factory_order_id ?? receipts[0]?.factory_order_id ?? ''
    ));
  }, [receipts]);

  useEffect(() => {
    if (!selectedReceipt) {
      setActualCounts({});
      setNote('');
      return;
    }
    setActualCounts(Object.fromEntries(selectedReceipt.items.map((item) => [
      item.ice_type_id,
      item.actual_quantity ?? item.expected_quantity,
    ])));
    setNote(selectedReceipt.note ?? '');
  }, [selectedReceipt]);

  const setQuantity = (iceTypeId: string, rawValue: string) => {
    const value = Number(rawValue);
    setActualCounts((current) => ({
      ...current,
      [iceTypeId]: Number.isFinite(value) ? Math.max(0, Math.round(value * 2) / 2) : 0,
    }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedReceipt || isRecorded) return;
    void onSaveReceipt(
      selectedReceipt.factory_order_id,
      selectedReceipt.items.map((item) => ({
        ice_type_id: item.ice_type_id,
        actual_quantity: actualCounts[item.ice_type_id] ?? 0,
      })),
      note,
    );
  };

  if (!summary) return <p className="empty-text">กำลังโหลดรายการรับจากโรงงาน...</p>;
  if (receipts.length === 0) return <p className="empty-text">ยังไม่มีรายการจากโรงงานสำหรับรถรับส่งหลักในวันนี้</p>;

  return (
    <form className="stock-v2-panel stock-count-panel" onSubmit={submit}>
      <div className="stock-v2-panel__header">
        <div>
          <h3>ตรวจรับจากโรงงาน</h3>
          <p className="muted">รถรับสินค้า: <strong>{summary.truck_location_name ?? '-'}</strong></p>
        </div>
      </div>

      <label className="stock-count-note" htmlFor="factory-order">
        <span>รายการจากโรงงาน</span>
        <select
          id="factory-order"
          value={selectedReceipt?.factory_order_id ?? ''}
          disabled={loading}
          onChange={(event) => setSelectedOrderId(event.target.value)}
        >
          {receipts.map((receipt, index) => (
            <option key={receipt.factory_order_id} value={receipt.factory_order_id}>
              รายการที่ {index + 1} — {receipt.status === 'pending' ? 'รอตรวจรับ' : 'บันทึกแล้ว'}
            </option>
          ))}
        </select>
      </label>

      {selectedReceipt ? (
        <section className="factory-receipt-summary" aria-label="สรุปตรวจรับจากโรงงาน">
          <div className="factory-receipt-summary__heading">
            <Package size={18} weight="fill" />
            <div>
              <strong>{isRecorded ? 'ผลตรวจรับที่บันทึกแล้ว' : 'กรอกยอดที่รับจริง'}</strong>
              <p>ยอดขาดหรือเกินจะปรับสต๊อกรถตามยอดรับจริงทันที</p>
            </div>
          </div>
          <div className="factory-receipt-summary__table" role="table">
            <div className="factory-receipt-summary__row factory-receipt-summary__row--header" role="row">
              <span role="columnheader">รายการ</span>
              <span role="columnheader">จากโรงงาน</span>
              <span role="columnheader">รับจริง</span>
              <span role="columnheader">ผลตรวจ</span>
            </div>
            {selectedReceipt.items.map((item) => {
              const actual = actualCounts[item.ice_type_id] ?? 0;
              const variance = actual - item.expected_quantity;
              const label = variance === 0 ? 'ตรง' : variance < 0 ? `ขาด ${Math.abs(variance)}` : `เกิน ${variance}`;
              const tone = variance === 0 ? 'match' : variance < 0 ? 'short' : 'over';
              return (
                <div className="factory-receipt-summary__row" key={item.ice_type_id} role="row">
                  <strong role="cell"><Snowflake size={14} weight="fill" /> {item.ice_type_name}</strong>
                  <span role="cell">{item.expected_quantity} {item.unit}</span>
                  <span role="cell">
                    <input
                      aria-label={`รับจริง ${item.ice_type_name}`}
                      type="number"
                      min={0}
                      step={0.5}
                      value={actual === 0 ? '' : actual}
                      disabled={loading || isRecorded}
                      onChange={(event) => setQuantity(item.ice_type_id, event.target.value)}
                    /> {item.unit}
                  </span>
                  <span className={`factory-receipt-status factory-receipt-status--${tone}`} role="cell">
                    {label}{variance === 0 ? '' : ` ${item.unit}`}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {!isRecorded ? (
        <>
          <div className="stock-count-note">
            <label htmlFor="factory-receipt-note">บันทึกหมายเหตุเพิ่มเติม:</label>
            <input
              id="factory-receipt-note"
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={loading}
            />
          </div>
          <p className="muted">กรุณาตรวจรับก่อนโอนหรือส่งของออกจากรถ เพื่อให้ยอดคงเหลือถูกต้อง</p>
        </>
      ) : null}

      {error ? <div className="error-text">⚠️ {error}</div> : null}
      {successMessage ? <div className="success-text stock-v2-feedback"><Check size={16} /> {successMessage}</div> : null}
      {!isRecorded ? (
        <button type="submit" className="primary-button" disabled={loading || !selectedReceipt}>
          {loading ? 'กำลังบันทึกยอดรับ...' : 'บันทึกผลการตรวจรับ'}
        </button>
      ) : null}
    </form>
  );
}

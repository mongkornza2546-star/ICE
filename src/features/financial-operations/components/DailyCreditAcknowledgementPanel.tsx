import { Camera, FileText, Printer, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { uploadDailyCreditAcknowledgementEvidence } from '../../../lib/dailyCreditAcknowledgementEvidence';
import { printDailyCreditAcknowledgement, type DailyCreditAcknowledgementDocument } from '../../../lib/dailyCreditAcknowledgementPrint';
import { getErrorMessage } from '../../../lib/errorMessage';
import { toBangkokDateString } from '../../../lib/serviceDate';
import { supabase } from '../../../lib/supabase';
import { subscribeToDataChange } from '../../../lib/dataChange';
import { money } from '../utils';

type DailyCreditAcknowledgementSummary = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  shop_location: string | null;
  invoice_count: number;
  total_amount: number;
  latest_delivery_at: string;
  open_round_count: number;
  document_id: string | null;
  document_version: number | null;
  is_stale: boolean;
  evidence_count: number;
  latest_evidence_path: string | null;
};

const dateTime = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

export function DailyCreditAcknowledgementPanel({ serviceDate }: { serviceDate: string }) {
  const [selectedDate, setSelectedDate] = useState(serviceDate);
  const [items, setItems] = useState<DailyCreditAcknowledgementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyShopId, setBusyShopId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = toBangkokDateString();

  useEffect(() => setSelectedDate(serviceDate), [serviceDate]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: loadError } = await supabase.rpc('list_daily_credit_acknowledgements', {
        p_service_date: selectedDate,
      });
      if (loadError) throw loadError;
      setItems((data ?? []) as DailyCreditAcknowledgementSummary[]);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeToDataChange(['receivable'], () => { void load(); }), [load]);

  const print = async (item: DailyCreditAcknowledgementSummary) => {
    const printWindow = window.open('', '_blank', 'popup,width=360,height=680');
    if (!printWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    setBusyShopId(item.shop_id);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error: printError } = await supabase.rpc('prepare_daily_credit_acknowledgement', {
        p_shop_id: item.shop_id,
        p_service_date: selectedDate,
      });
      if (printError) throw printError;
      if (!printDailyCreditAcknowledgement(data as DailyCreditAcknowledgementDocument, printWindow)) {
        throw new Error('ไม่สามารถเปิดหน้าต่างพิมพ์ได้');
      }
      await load();
    } catch (printError) {
      printWindow.close();
      setError(getErrorMessage(printError));
    } finally {
      setBusyShopId(null);
    }
  };

  const uploadEvidence = async (item: DailyCreditAcknowledgementSummary, file: File | null) => {
    if (!file) return;
    if (!item.document_id) {
      setError('กรุณาพิมพ์ใบสรุปก่อนแนบรูปใบเซ็น');
      return;
    }
    setBusyShopId(item.shop_id);
    setError(null);
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const path = await uploadDailyCreditAcknowledgementEvidence(file, item.document_id);
      const { error: attachError } = await supabase.rpc('attach_daily_credit_acknowledgement_evidence', {
        p_document_id: item.document_id,
        p_storage_path: path,
      });
      if (attachError) throw attachError;
      await load();
    } catch (uploadError) {
      setError(getErrorMessage(uploadError));
    } finally {
      setBusyShopId(null);
    }
  };

  const viewEvidence = async (item: DailyCreditAcknowledgementSummary) => {
    if (!item.latest_evidence_path || !supabase) return;
    const evidenceWindow = window.open('', '_blank');
    if (!evidenceWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างรูป กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    try {
      const { data, error: urlError } = await supabase.storage
        .from('credit-signoff-evidence')
        .createSignedUrl(item.latest_evidence_path, 3600);
      if (urlError || !data?.signedUrl) throw urlError ?? new Error('ไม่สามารถเปิดรูปใบเซ็นได้');
      evidenceWindow.location.href = data.signedUrl;
    } catch (viewError) {
      evidenceWindow.close();
      setError(getErrorMessage(viewError));
    }
  };

  return <section className="financial-ops__section daily-credit-signoff" aria-labelledby="daily-credit-signoff-title">
    <div className="financial-ops__title">
      <div><FileText /><span><h2 id="daily-credit-signoff-title">ใบเซ็นเครดิตรายวัน</h2><p>รวมทุกใบ INV ของร้านในวันเดียว เพื่อให้ร้านตรวจและเซ็นครั้งเดียว</p></span></div>
      <label>วันที่<input max={today} onChange={(event) => setSelectedDate(event.target.value)} type="date" value={selectedDate} /></label>
    </div>
    {error ? <p className="credit-ar__action-error" role="alert"><WarningCircle size={18} />{error}</p> : null}
    {loading ? <p className="financial-ops__empty">กำลังโหลดใบเครดิต...</p> : null}
    {!loading && items.length === 0 ? <p className="financial-ops__empty">วันนี้ยังไม่มีรายการส่งร้านเครดิต</p> : null}
    <div className="daily-credit-signoff__list">
      {items.map((item) => {
        const busy = busyShopId === item.shop_id;
        const label = item.is_stale ? 'ยอดเปลี่ยน · พิมพ์ฉบับใหม่' : item.document_id ? `ฉบับที่ ${item.document_version}` : 'ยังไม่ได้สร้างใบ';
        return <article key={item.shop_id}>
          <div className="daily-credit-signoff__summary">
            <span><strong>{item.shop_code} · {item.shop_name}</strong><small>{item.shop_location ?? '—'} · {item.invoice_count} INV · ส่งล่าสุด {dateTime.format(new Date(item.latest_delivery_at))}</small></span>
            <b>{money.format(Number(item.total_amount))}</b>
          </div>
          {item.open_round_count > 0 ? <p className="daily-credit-signoff__warning"><WarningCircle size={15} />ยังมีรอบส่งเปิดอยู่ ยอดอาจเพิ่มได้</p> : null}
          <footer>
            <span className={item.is_stale ? 'is-stale' : ''}>{label}{item.evidence_count ? ` · มีรูปใบเซ็น ${item.evidence_count} รูป` : ''}</span>
            <div>
              <button disabled={busy} onClick={() => void print(item)} type="button"><Printer size={17} />{item.document_id && !item.is_stale ? 'พิมพ์ซ้ำ' : 'พิมพ์ใบรวม'}</button>
              <label className="daily-credit-signoff__upload"><Camera size={17} />แนบรูป<input accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => { void uploadEvidence(item, event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ''; }} type="file" /></label>
              {item.latest_evidence_path ? <button disabled={busy} onClick={() => void viewEvidence(item)} type="button">ดูรูป</button> : null}
            </div>
          </footer>
        </article>;
      })}
    </div>
  </section>;
}

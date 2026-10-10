import { uiDateTimeFormat, translateUi, useLanguage } from '../../../i18n';
import { ArrowLeft, CaretRight, FileText, Printer, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { withAsyncPublicImageUrls } from '../../../lib/publicImageUrls';
import { getHybridObjectUrl, getHybridObjectUrls } from '../../../lib/r2Storage';
import { printDailyCreditAcknowledgementForCurrentPlatform, type DailyCreditAcknowledgementDocument } from '../../../lib/dailyCreditAcknowledgementPrint';
import { isAndroidApp } from '../../../lib/thermalPrinter';
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
  building_id: string | null;
  building_name: string | null;
  zone_id: string | null;
  zone_name: string | null;
  image_path: string | null;
  image_url?: string | null;
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

type CreditInvoice = DailyCreditAcknowledgementDocument['invoices'][number];

const dateTime = uiDateTimeFormat({
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

export function DailyCreditAcknowledgementPanel({ serviceDate, printerName, shopId, onBack }: {
  serviceDate: string;
  printerName?: string;
  shopId?: string;
  onBack?: () => void;
}) {
  useLanguage();
  const [selectedDate, setSelectedDate] = useState(serviceDate);
  const [items, setItems] = useState<DailyCreditAcknowledgementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyShopId, setBusyShopId] = useState<string | null>(null);
  const [buildingId, setBuildingId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [internalShopId, setSelectedShopId] = useState<string | null>(null);
  const selectedShopId = shopId ?? internalShopId;
  const [detail, setDetail] = useState<{ shopId: string; invoices: CreditInvoice[] | null; error: string | null } | null>(null);
  const detailRequest = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const lastOpenedShopId = useRef<string | null>(null);
  const historyOwner = useId();
  const [error, setError] = useState<string | null>(null);
  const today = toBangkokDateString();

  const buildings = useMemo(() => [...new Map(items.filter((item) => item.building_id && item.building_name)
    .map((item) => [item.building_id!, item.building_name!] as const)).entries()]
    .sort((left, right) => left[1].localeCompare(right[1], 'th')), [items]);
  const zones = useMemo(() => [...new Map(items.filter((item) => item.zone_id && item.zone_name && (!buildingId || item.building_id === buildingId))
    .map((item) => [item.zone_id!, { name: item.zone_name!, buildingName: item.building_name }] as const)).entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name, 'th')), [buildingId, items]);
  const filteredItems = useMemo(() => items.filter((item) =>
    (!buildingId || item.building_id === buildingId) && (!zoneId || item.zone_id === zoneId)), [buildingId, items, zoneId]);
  const selectedShop = items.find((item) => item.shop_id === selectedShopId);

  useEffect(() => {
    setSelectedDate(serviceDate);
    detailRequest.current += 1;
    setDetail(null);
    setSelectedShopId(null);
    lastOpenedShopId.current = null;
    if (window.history.state?.dailyCreditShop?.owner === historyOwner) window.history.back();
  }, [historyOwner, serviceDate]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const entry = event.state?.dailyCreditShop;
      const shopId = entry?.owner === historyOwner && entry?.date === selectedDate && typeof entry?.shopId === 'string'
        ? entry.shopId : null;
      detailRequest.current += 1;
      setDetail(null);
      if (shopId) lastOpenedShopId.current = shopId;
      setSelectedShopId(shopId);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [historyOwner, selectedDate]);

  useEffect(() => () => {
    // Leave the list entry active when another app tab unmounts this panel.
    if (window.history.state?.dailyCreditShop?.owner === historyOwner) window.history.back();
  }, [historyOwner]);
  useEffect(() => {
    if (buildingId && !buildings.some(([id]) => id === buildingId)) {
      setBuildingId('');
      setZoneId('');
    }
  }, [buildingId, buildings]);
  useEffect(() => {
    if (zoneId && !zones.some(([id]) => id === zoneId)) setZoneId('');
  }, [zoneId, zones]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: loadError } = await supabase.rpc('list_daily_credit_acknowledgements', {
        p_service_date: selectedDate,
      });
      if (loadError) throw loadError;
      const summaries = (data ?? []) as DailyCreditAcknowledgementSummary[];
      const shopImageBucket = supabase.storage.from('shop-images');
      setItems(await withAsyncPublicImageUrls(summaries, (paths) => getHybridObjectUrls(
        'shop-images', paths, async (supabasePaths) => supabasePaths.map((path) => ({
          path,
          signedUrl: shopImageBucket.getPublicUrl(path).data.publicUrl,
        })),
      )));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeToDataChange(['receivable'], () => { void load(); }), [load]);
  useLayoutEffect(() => {
    if (!selectedShopId) return;
    const target = sectionRef.current?.querySelector<HTMLButtonElement>('.daily-credit-signoff__back');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'start' });
  }, [selectedShopId]);
  useLayoutEffect(() => {
    if (selectedShopId || loading || !lastOpenedShopId.current) return;
    const target = document.getElementById(`credit-shop-${lastOpenedShopId.current}`) ?? sectionRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'center' });
    lastOpenedShopId.current = null;
  }, [filteredItems, loading, selectedShopId]);

  const openDetail = async (item: DailyCreditAcknowledgementSummary) => {
    const request = ++detailRequest.current;
    setDetail({ shopId: item.shop_id, invoices: null, error: null });
    try {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
      const { data, error: detailError } = await supabase.rpc('get_daily_credit_acknowledgement_details', {
        p_shop_id: item.shop_id,
        p_service_date: selectedDate,
      });
      if (detailError) throw detailError;
      if (request === detailRequest.current) setDetail({ shopId: item.shop_id, invoices: (data ?? []) as CreditInvoice[], error: null });
    } catch (detailError) {
      if (request === detailRequest.current) setDetail({ shopId: item.shop_id, invoices: null, error: getErrorMessage(detailError) });
    }
  };

  useEffect(() => {
    const item = items.find((entry) => entry.shop_id === selectedShopId);
    if (item) void openDetail(item);
  }, [items, selectedDate, selectedShopId]);

  const closeShop = () => {
    if (window.history.state?.dailyCreditShop?.owner === historyOwner) {
      window.history.back();
      return;
    }
    detailRequest.current += 1;
    setDetail(null);
    setSelectedShopId(null);
  };

  const selectShop = (shopId: string) => {
    window.history.pushState({
      ...window.history.state,
      dailyCreditShop: { owner: historyOwner, date: selectedDate, shopId },
    }, '');
    lastOpenedShopId.current = shopId;
    setSelectedShopId(shopId);
  };

  const print = async (item: DailyCreditAcknowledgementSummary) => {
    const nativeAndroid = isAndroidApp();
    const printWindow = nativeAndroid ? null : window.open('', '_blank', 'popup,width=360,height=680');
    if (!nativeAndroid && !printWindow) {
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
      if (!await printDailyCreditAcknowledgementForCurrentPlatform({
        ...(data as DailyCreditAcknowledgementDocument),
        printed_by_nickname: printerName,
      }, printWindow)) {
        throw new Error('ไม่สามารถเปิดหน้าต่างพิมพ์ได้');
      }
      await load();
    } catch (printError) {
      printWindow?.close();
      setError(getErrorMessage(printError));
    } finally {
      setBusyShopId(null);
    }
  };

  const viewEvidence = async (item: DailyCreditAcknowledgementSummary) => {
    if (!item.latest_evidence_path || !supabase) return;
    const client = supabase;
    const evidenceWindow = window.open('', '_blank');
    if (!evidenceWindow) {
      setError('เบราว์เซอร์บล็อกหน้าต่างรูป กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
      return;
    }
    try {
      const signedUrl = await getHybridObjectUrl('credit-signoff-evidence', item.latest_evidence_path, async () => {
        const { data, error: urlError } = await client.storage
          .from('credit-signoff-evidence')
          .createSignedUrl(item.latest_evidence_path!, 3600);
        if (urlError || !data?.signedUrl) throw urlError ?? new Error('ไม่สามารถเปิดรูปใบเซ็นได้');
        return data.signedUrl;
      });
      evidenceWindow.location.href = signedUrl;
    } catch (viewError) {
      evidenceWindow.close();
      setError(getErrorMessage(viewError));
    }
  };

  return <section className="financial-ops__section daily-credit-signoff" aria-labelledby={selectedShopId ? 'daily-credit-shop-title' : 'daily-credit-signoff-title'} ref={sectionRef} tabIndex={-1}>
    {selectedShopId ? <>
      <button className="daily-credit-signoff__back" onClick={onBack ?? closeShop} type="button"><ArrowLeft size={20} />{translateUi(onBack ? 'กลับ POS' : 'กลับรายชื่อร้าน')}</button>
      {selectedShop ? <>
        <div className="daily-credit-signoff__shop-header">
          <div className="daily-credit-signoff__shop">
            {selectedShop.image_url ? <img alt={translateUi('รูปร้าน {0} · {1}', { 0: selectedShop.shop_code, 1: selectedShop.shop_name })} src={selectedShop.image_url} /> : null}
            <span><small>{translateUi('ใบเซ็นเครดิตรายวัน')} · {selectedDate}</small><h2 id="daily-credit-shop-title">{selectedShop.shop_code} · {selectedShop.shop_name}</h2><small>{selectedShop.building_name && selectedShop.zone_name ? `${selectedShop.building_name} · ${selectedShop.zone_name} · ` : ''}{selectedShop.shop_location ?? '—'}</small></span>
          </div>
          <div className="daily-credit-signoff__shop-total"><small>{selectedShop.invoice_count} INV</small><strong>{money.format(Number(selectedShop.total_amount))}</strong></div>
        </div>
        {selectedShop.open_round_count > 0 ? <p className="daily-credit-signoff__warning"><WarningCircle size={15} />{translateUi('ยังมีรอบส่งเปิดอยู่ ยอดอาจเพิ่มได้')}</p> : null}
        {error ? <p className="credit-ar__action-error" role="alert"><WarningCircle size={18} />{translateUi(error)}</p> : null}
        <div className="daily-credit-signoff__details">
          <h3>{translateUi('รายละเอียดของ ')}{selectedShop.shop_name}</h3>
          {detail?.shopId === selectedShopId && !detail.invoices && !detail.error ? <p role="status">{translateUi('กำลังโหลดรายละเอียด...')}</p> : null}
          {detail?.shopId === selectedShopId && detail.error ? <p role="alert">{translateUi(detail.error)} <button onClick={() => void openDetail(selectedShop)} type="button">{translateUi('ลองอีกครั้ง')}</button></p> : null}
          {detail?.shopId === selectedShopId && detail.invoices?.map((invoice) => <div className="daily-credit-signoff__invoice" key={invoice.document_number}>
            <div><strong>{invoice.document_number}</strong><b>{money.format(Number(invoice.total_amount))}</b></div>
            <small>{translateUi('ส่ง ')}{dateTime.format(new Date(invoice.recorded_at))}{invoice.recorded_by ? ` · ${invoice.recorded_by}` : ''}</small>
            <ul>{invoice.items.map((line, index) => <li key={`${line.ice_type_name}-${index}`}>
              <span>{line.ice_type_name} · {Number(line.quantity)} {line.ice_type_unit}{line.unit_price == null ? '' : ` × ${money.format(Number(line.unit_price))}`}</span>
              <b>{money.format(Number(line.line_total))}</b>
            </li>)}</ul>
          </div>)}
          {detail?.shopId === selectedShopId && detail.invoices ? <div className="daily-credit-signoff__detail-total"><strong>{translateUi('รวม ')}{detail.invoices.length} INV</strong><b>{money.format(detail.invoices.reduce((sum, invoice) => sum + Number(invoice.total_amount), 0))}</b></div> : null}
        </div>
        <div className="daily-credit-signoff__actions">
          <span className={selectedShop.is_stale ? 'is-stale' : ''}>{selectedShop.is_stale ? 'ยอดเปลี่ยน · พิมพ์ฉบับใหม่' : selectedShop.document_id ? translateUi('ฉบับที่ {0}', { 0: selectedShop.document_version ?? '—' }) : 'ยังไม่ได้สร้างใบ'}{selectedShop.evidence_count ? translateUi(' · มีรูปใบเซ็น {0} รูป', { 0: selectedShop.evidence_count }) : ''}</span>
          <div>
            <button disabled={busyShopId === selectedShopId} onClick={() => void print(selectedShop)} type="button"><Printer size={17} />{selectedShop.document_id && !selectedShop.is_stale ? translateUi('พิมพ์ซ้ำ') : translateUi('พิมพ์ใบรวม')}</button>
            {selectedShop.latest_evidence_path ? <button disabled={busyShopId === selectedShopId} onClick={() => void viewEvidence(selectedShop)} type="button">{translateUi('ดูรูป')}</button> : null}
          </div>
        </div>
      </> : <>
        {error ? <p className="credit-ar__action-error" role="alert">{translateUi(error)} <button onClick={() => void load()} type="button">{translateUi('ลองอีกครั้ง')}</button></p> : null}
        {!error ? <p className="financial-ops__empty" id="daily-credit-shop-title">{translateUi(loading ? 'กำลังโหลดใบเครดิต...' : shopId ? 'วันนี้ยังไม่มีรายการส่งร้านเครดิต' : 'ไม่มีร้านในตึกและโซนที่เลือก')}</p> : null}
      </>}
    </> : <>
    <div className="financial-ops__title">
      <div><FileText /><span><h2 id="daily-credit-signoff-title">{translateUi('ใบเซ็นเครดิตรายวัน')}</h2><p>{translateUi('รวมทุกใบ INV ของร้านในวันเดียว เพื่อให้ร้านตรวจและเซ็นครั้งเดียว')}</p></span></div>
      <label>{translateUi('วันที่')}<input max={today} onChange={(event) => { setSelectedDate(event.target.value); closeShop(); }} type="date" value={selectedDate} /></label>
    </div>
    <div className="daily-credit-signoff__filters">
      <label>{translateUi('ตึก')}<select onChange={(event) => { setBuildingId(event.target.value); setZoneId(''); }} value={buildingId}>
          <option value="">{translateUi('ทุกตึก')}</option>
          {buildings.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label>{translateUi('โซน')}<select onChange={(event) => setZoneId(event.target.value)} value={zoneId}>
          <option value="">{translateUi('ทุกโซน')}</option>
          {zones.map(([id, zone]) => <option key={id} value={id}>{zone.name}{!buildingId && zone.buildingName ? ` · ${zone.buildingName}` : ''}</option>)}
        </select>
      </label>
    </div>
    {error ? <p className="credit-ar__action-error" role="alert"><WarningCircle size={18} />{translateUi(error)}</p> : null}
    {loading ? <p className="financial-ops__empty">{translateUi('กำลังโหลดใบเครดิต...')}</p> : null}
    {!loading && items.length === 0 ? <p className="financial-ops__empty">{translateUi('วันนี้ยังไม่มีรายการส่งร้านเครดิต')}</p> : null}
    {!loading && items.length > 0 && filteredItems.length === 0 ? <p className="financial-ops__empty">{translateUi('ไม่มีร้านในตึกและโซนที่เลือก')}</p> : null}
    <div className="daily-credit-signoff__list">
      {!loading && filteredItems.map((item) => {
        const label = item.is_stale ? 'ยอดเปลี่ยน · พิมพ์ฉบับใหม่' : item.document_id ? translateUi('ฉบับที่ {0}', { 0: item.document_version ?? '—' }) : 'ยังไม่ได้สร้างใบ';
        return <article key={item.shop_id}>
          <button className="daily-credit-signoff__entry" id={`credit-shop-${item.shop_id}`} onClick={() => selectShop(item.shop_id)} type="button">
          <div className="daily-credit-signoff__summary">
            <div className="daily-credit-signoff__shop">
              {item.image_url ? <img alt={translateUi('รูปร้าน {0} · {1}', { 0: item.shop_code, 1: item.shop_name })} decoding="async" loading="lazy" src={item.image_url} /> : null}
              <span><strong>{item.shop_code} · {item.shop_name}</strong><small>{item.building_name && item.zone_name ? `${item.building_name} · ${item.zone_name} · ` : ''}{item.shop_location ?? '—'} · {item.invoice_count}{translateUi(' INV · ส่งล่าสุด ')}{dateTime.format(new Date(item.latest_delivery_at))}</small></span>
            </div>
            <span className="daily-credit-signoff__amount"><b>{money.format(Number(item.total_amount))}</b><CaretRight size={20} /></span>
          </div>
          {item.open_round_count > 0 ? <p className="daily-credit-signoff__warning"><WarningCircle size={15} />{translateUi('ยังมีรอบส่งเปิดอยู่ ยอดอาจเพิ่มได้')}</p> : null}
          <span className={item.is_stale ? 'daily-credit-signoff__status is-stale' : 'daily-credit-signoff__status'}>{label}{item.evidence_count ? translateUi(' · มีรูปใบเซ็น {0} รูป', { 0: item.evidence_count }) : ''}</span>
          </button>
        </article>;
      })}
    </div>
    </>}
  </section>;
}

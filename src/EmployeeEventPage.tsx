import { uiDateTimeFormat, translateUi, useLanguage } from './i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowLeft, ArrowClockwise, CalendarBlank, CaretRight, CheckCircle, CircleNotch,
  MagnifyingGlass, MapPin, Minus, Plus, Storefront, WarningCircle, X,
} from '@phosphor-icons/react';
import { employeeEventGateway } from './features/employee-events/employeeEventGateway';
import { EmployeeEventDialog } from './features/employee-events/EmployeeEventDialog';
import type {
  EmployeeEventBooth, EmployeeEventDetail, EmployeeEventGateway, EmployeeEventSummary,
} from './features/employee-events/types';
import { useBangkokServiceDate } from './hooks/useBangkokServiceDate';
import { toBangkokDateString } from './lib/serviceDate';

interface BoothDraft {
  boothNumber: string;
  shopName: string;
  eventZone: string;
  contactName: string;
  contactPhone: string;
  requestId: string;
}
interface HandoffDraft {
  booth: EmployeeEventBooth;
  quantity: string;
  note: string;
  requestId: string;
}
type EventFilter = 'today' | 'upcoming' | 'ended';
type EventStage = 'active' | 'preparing' | 'upcoming' | 'ended';
const FILTERS: { value: EventFilter; label: string }[] = [
  { value: 'today', label: 'วันนี้' }, { value: 'upcoming', label: 'กำลังจะมา' }, { value: 'ended', label: 'จบแล้ว' },
];
const STAGE_LABELS: Record<EventStage, string> = {
  active: 'กำลังจัดงาน', preparing: 'เตรียมงาน', upcoming: 'กำลังจะมา', ended: 'จบแล้ว',
};
function formatDate(value: string) {
  return uiDateTimeFormat({ day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${value}T12:00:00+07:00`));
}
function eventStage(event: EmployeeEventSummary, today: string): EventStage {
  if (today > event.end_date) return 'ended';
  if (today >= event.start_date) return 'active';
  return today >= (event.preparation_start_date ?? event.start_date) ? 'preparing' : 'upcoming';
}
function eventFilter(event: EmployeeEventSummary, today: string): EventFilter {
  const stage = eventStage(event, today);
  return stage === 'active' || stage === 'preparing' ? 'today' : stage;
}
function handoffIssue(event: EmployeeEventSummary, booth: EmployeeEventBooth, today: string): string | null {
  if (booth.event_job_id !== event.id) return 'บูธนี้ไม่ได้อยู่ในงานที่เลือก';
  if (today > event.end_date) return 'งานจบแล้ว ดูข้อมูลได้';
  if (today > booth.end_date) return `บูธสิ้นสุดรับถัง ${formatDate(booth.end_date)}`;
  const firstDay = [event.preparation_start_date ?? event.start_date, booth.preparation_start_date ?? booth.start_date].sort()[1];
  if (firstDay > event.end_date || firstDay > booth.end_date) return 'บูธนี้ไม่มีช่วงวันที่เปิดรับถัง';
  return today < firstDay ? `ส่งถังได้ตั้งแต่ ${formatDate(firstDay)}` : null;
}
function emptyBoothDraft(): BoothDraft {
  return { boothNumber: '', shopName: '', eventZone: '', contactName: '', contactPhone: '', requestId: crypto.randomUUID() };
}

export function EmployeeEventPage({ gateway = employeeEventGateway, isActive = true }: {
  gateway?: EmployeeEventGateway;
  isActive?: boolean;
}) {
  useLanguage();
  const today = useBangkokServiceDate();
  const [events, setEvents] = useState<EmployeeEventSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmployeeEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventFilter>('today');
  const [eventQuery, setEventQuery] = useState('');
  const [boothQuery, setBoothQuery] = useState('');
  const [zone, setZone] = useState('');
  const [boothDraft, setBoothDraft] = useState<BoothDraft | null>(null);
  const [handoffDraft, setHandoffDraft] = useState<HandoffDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; values?: Record<string, string | number>; booth?: EmployeeEventBooth } | null>(null);
  const [highlightedBooth, setHighlightedBooth] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const selection = useRef<string | null>(null);
  const detailSequence = useRef(0);
  const overviewSequence = useRef(0);
  const submitting = useRef(false);
  const scrollPositions = useRef(new Map<string, number>());
  const boothFilters = useRef(new Map<string, { query: string; zone: string }>());
  const modalOpen = useRef(false);
  modalOpen.current = Boolean(boothDraft || handoffDraft);

  const loadOverview = useCallback(async () => {
    const sequence = ++overviewSequence.current;
    setLoading(true);
    setOverviewError(null);
    try {
      const next = await gateway.loadEvents();
      if (sequence === overviewSequence.current) setEvents(next);
    } catch (error) {
      if (sequence === overviewSequence.current) setOverviewError(error instanceof Error ? error.message : 'โหลดงานอีเวนต์ไม่สำเร็จ');
    } finally {
      if (sequence === overviewSequence.current) setLoading(false);
    }
  }, [gateway]);

  const loadDetail = useCallback(async (id: string, afterSave = false) => {
    const sequence = ++detailSequence.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const next = await gateway.loadEvent(id);
      if (sequence === detailSequence.current && selection.current === id) setDetail(next);
    } catch (error) {
      if (sequence === detailSequence.current && selection.current === id) {
        setDetailError(afterSave ? 'บันทึกรายการแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณาโหลดข้อมูลใหม่'
          : error instanceof Error ? error.message : 'โหลดรายละเอียดไม่สำเร็จ');
      }
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    if (!isActive) return;
    void loadOverview();
    if (selection.current) void loadDetail(selection.current);
    return () => { overviewSequence.current += 1; detailSequence.current += 1; };
  }, [isActive, loadOverview, loadDetail]);

  const detailReady = Boolean(detail);
  useEffect(() => {
    if (!success || success.booth) return;
    const timeout = window.setTimeout(() => setSuccess(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [success]);

  useLayoutEffect(() => {
    if (!isActive || (selectedId && !detailReady)) return;
    const key = selectedId ?? 'overview';
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: scrollPositions.current.get(key) ?? 0, behavior: 'auto' }));
    const remember = () => { if (!modalOpen.current) scrollPositions.current.set(key, window.scrollY); };
    window.addEventListener('scroll', remember, { passive: true });
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('scroll', remember); };
  }, [isActive, selectedId, detailReady]);

  useLayoutEffect(() => {
    if (!isActive) return;
    const header = pageRef.current?.closest('.employee-shell')?.querySelector('.employee-header');
    if (!header) return;
    const update = () => pageRef.current?.style.setProperty('--event-header-height', `${header.getBoundingClientRect().height}px`);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, [isActive]);

  const chooseEvent = (id: string) => {
    scrollPositions.current.set('overview', window.scrollY);
    selection.current = id;
    setSelectedId(id);
    setDetail(null);
    setSuccess(null);
    setActionError(null);
    setHighlightedBooth(null);
    const saved = boothFilters.current.get(id);
    setBoothQuery(saved?.query ?? '');
    setZone(saved?.zone ?? '');
    window.scrollTo({ top: 0, behavior: 'auto' });
    void loadDetail(id);
  };
  const goBack = () => {
    if (selectedId) {
      scrollPositions.current.set(selectedId, window.scrollY);
      boothFilters.current.set(selectedId, { query: boothQuery, zone });
    }
    detailSequence.current += 1;
    selection.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setSuccess(null);
    setActionError(null);
  };
  const resetFilters = () => { setBoothQuery(''); setZone(''); };
  const startBooth = () => { setActionError(null); setBoothDraft(emptyBoothDraft()); };
  const openHandoff = (booth: EmployeeEventBooth) => {
    if (!detail || handoffIssue(detail.event, booth, toBangkokDateString())) return;
    setActionError(null);
    setHandoffDraft({ booth, quantity: '1', note: '', requestId: crypto.randomUUID() });
  };
  const closeForm = () => { setBoothDraft(null); setHandoffDraft(null); setActionError(null); };

  const counts = useMemo(() => events.reduce((result, event) => {
    result[eventFilter(event, today)] += 1;
    return result;
  }, { today: 0, upcoming: 0, ended: 0 }), [events, today]);
  const filteredEvents = useMemo(() => {
    const query = eventQuery.trim().toLocaleLowerCase('th');
    return events.filter((event) => eventFilter(event, today) === filter
      && (!query || `${event.name} ${event.location}`.toLocaleLowerCase('th').includes(query)))
      .sort((a, b) => {
        if (filter === 'ended') return b.end_date.localeCompare(a.end_date) || a.name.localeCompare(b.name, 'th');
        if (filter === 'today') {
          const difference = Number(eventStage(a, today) === 'preparing') - Number(eventStage(b, today) === 'preparing');
          if (difference) return difference;
        }
        return (a.preparation_start_date ?? a.start_date).localeCompare(b.preparation_start_date ?? b.start_date) || a.name.localeCompare(b.name, 'th');
      });
  }, [events, filter, eventQuery, today]);
  const zones = useMemo(() => Array.from(new Set((detail?.booths ?? []).map((booth) => booth.event_zone)
    .filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, 'th', { numeric: true })), [detail]);
  const filteredBooths = useMemo(() => {
    const query = boothQuery.trim().toLocaleLowerCase('th');
    return (detail?.booths ?? []).filter((booth) => (!zone || booth.event_zone === zone)
      && (!query || `${booth.booth_number} ${booth.shop_name} ${booth.event_zone ?? ''}`.toLocaleLowerCase('th').includes(query)))
      .sort((a, b) => (a.event_zone ?? '').localeCompare(b.event_zone ?? '', 'th', { numeric: true })
        || a.booth_number.localeCompare(b.booth_number, 'th', { numeric: true }));
  }, [boothQuery, detail, zone]);

  const saveBooth = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || !boothDraft || !detail || !boothDraft.boothNumber.trim()) return;
    if (toBangkokDateString() > detail.event.end_date) { setActionError('งานจบแล้ว ไม่สามารถเพิ่มบูธได้'); return; }
    submitting.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const result = await gateway.createBooth({
        eventJobId: detail.event.id, requestId: boothDraft.requestId,
        boothNumber: boothDraft.boothNumber.trim(), shopName: boothDraft.shopName.trim(), eventZone: boothDraft.eventZone.trim(),
        contactName: boothDraft.contactName.trim(), contactPhone: boothDraft.contactPhone.trim(),
      });
      setSuccess({ message: result.duplicate ? 'บูธ {booth} มีอยู่แล้ว แสดงบูธเดิมให้แล้ว' : 'เพิ่มบูธ {booth} แล้ว', values: { booth: result.booth.booth_number }, booth: result.booth });
      setHighlightedBooth(result.booth.id);
      setBoothQuery(result.booth.booth_number);
      setZone(result.booth.event_zone ?? '');
      setDetail((current) => current ? { ...current, booths: [...current.booths.filter((booth) => booth.id !== result.booth.id), result.booth] } : current);
      await loadDetail(detail.event.id, true);
      setBoothDraft(null);
      void loadOverview();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'เพิ่มบูธไม่สำเร็จ');
    } finally { submitting.current = false; setBusy(false); }
  };

  const saveHandoff = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || !handoffDraft || !detail) return;
    const issue = handoffIssue(detail.event, handoffDraft.booth, toBangkokDateString());
    if (issue) { setActionError(issue); return; }
    const quantity = Number(handoffDraft.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      setActionError('กรอกจำนวนถังเป็นจำนวนเต็ม 1–10,000 ใบ'); return;
    }
    submitting.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await gateway.handoffTanks({ participationId: handoffDraft.booth.id, quantity, note: handoffDraft.note.trim(), requestId: handoffDraft.requestId });
      setSuccess({ message: 'ส่งถัง {quantity} ใบให้บูธ {booth} แล้ว', values: { quantity: quantity.toLocaleString('th-TH'), booth: handoffDraft.booth.booth_number } });
      setHighlightedBooth(handoffDraft.booth.id);
      setDetail((current) => current ? { ...current, booths: current.booths.map((booth) => booth.id === handoffDraft.booth.id
        ? { ...booth, tank_handoff_count: booth.tank_handoff_count + quantity, tank_balance: booth.tank_balance + quantity } : booth) } : current);
      await loadDetail(handoffDraft.booth.event_job_id, true);
      setHandoffDraft(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'บันทึกส่งถังไม่สำเร็จ');
    } finally { submitting.current = false; setBusy(false); }
  };

  const ended = Boolean(detail && today > detail.event.end_date);
  const handoffQuantity = Number(handoffDraft?.quantity) || 0;
  return (
    <section className="employee-event-page" ref={pageRef} aria-label={translateUi('อีเวนต์พนักงาน')}>
      {!selectedId ? <>
        <header className="employee-event-heading"><div><p className="eyebrow">{translateUi('งานของพนักงาน')}</p><h1>{translateUi('อีเวนต์')}</h1><p className="employee-event-subtitle">{translateUi('เลือกงาน แล้วค้นหาบูธเพื่อส่งถัง')}</p></div><button aria-label={translateUi('โหลดงานใหม่')} className="employee-event-icon-button" disabled={loading} onClick={() => void loadOverview()} type="button"><ArrowClockwise size={22} /></button></header>
        <nav aria-label={translateUi('ช่วงเวลาของงาน')} className="employee-event-tabs">{FILTERS.map((item) => <button aria-pressed={filter === item.value} key={item.value} onClick={() => setFilter(item.value)} type="button">{translateUi(item.label)}<span>{counts[item.value]}</span></button>)}</nav>
        <SearchField label={translateUi('ค้นหางาน')} placeholder={translateUi('ค้นหาชื่องานหรือสถานที่')} value={eventQuery} onChange={setEventQuery} />
        {overviewError ? <Notice error action={<button disabled={loading} onClick={() => void loadOverview()} type="button">{translateUi('ลองอีกครั้ง')}</button>}>{translateUi(overviewError)}</Notice> : null}
        {loading && events.length === 0 ? <LoadingState text={translateUi('กำลังโหลดงานอีเวนต์')} /> : !overviewError && filteredEvents.length === 0 ? <div className="employee-event-empty"><CalendarBlank size={36} /><h2>{eventQuery.trim() ? translateUi('ไม่พบงานที่ค้นหา') : filter === 'today' ? translateUi('วันนี้ยังไม่มีงานอีเวนต์') : filter === 'upcoming' ? translateUi('ยังไม่มีงานที่กำลังจะมา') : translateUi('ยังไม่มีงานที่จบแล้ว')}</h2><p>{eventQuery.trim() ? translateUi('ลองเปลี่ยนคำค้นหรือดูงานในช่วงเวลาอื่น') : translateUi('เลือกช่วงเวลาด้านบนเพื่อดูงานอื่น')}</p>{eventQuery ? <button className="secondary-button" onClick={() => setEventQuery('')} type="button">{translateUi('ล้างคำค้น')}</button> : filter === 'today' ? <div><button className="secondary-button" onClick={() => setFilter('upcoming')} type="button">{translateUi('ดูงานที่กำลังจะมา')}</button><button className="employee-event-text-button" onClick={() => setFilter('ended')} type="button">{translateUi('ดูงานที่จบแล้ว')}</button></div> : null}</div> : null}
        <div className="employee-event-list" aria-label={translateUi('เลือกงานอีเวนต์')}>{filteredEvents.map((event) => <button className="employee-event-card" key={event.id} onClick={() => chooseEvent(event.id)} type="button"><div className="employee-event-card__top"><span className={`employee-event-status employee-event-status--${eventStage(event, today)}`}>{translateUi(STAGE_LABELS[eventStage(event, today)])}</span><span>{event.active_participation_count}{translateUi(' บูธ')}</span></div><strong>{event.name}</strong><span><CalendarBlank size={17} />{formatDate(event.start_date)} – {formatDate(event.end_date)}</span><span><MapPin size={17} />{event.location || translateUi('ไม่ระบุสถานที่')}</span><span className="employee-event-card__action">{translateUi('ดูบูธในงาน')}<CaretRight size={19} /></span></button>)}</div>
      </> : <>
        <button className="employee-event-back" disabled={busy} onClick={goBack} type="button"><ArrowLeft size={19} />{translateUi('กลับไปเลือกงาน')}</button>
        {!detail && detailLoading ? <LoadingState text={translateUi('กำลังโหลดรายละเอียดงาน')} /> : null}
        {detailError ? <Notice error action={<button disabled={detailLoading || busy} onClick={() => void loadDetail(selectedId)} type="button">{translateUi('โหลดข้อมูลใหม่')}</button>}>{translateUi(detailError)}</Notice> : null}
        {detail ? <>
          <header className="employee-event-heading employee-event-heading--detail"><div><span className={`employee-event-status employee-event-status--${eventStage(detail.event, today)}`}>{translateUi(STAGE_LABELS[eventStage(detail.event, today)])}</span><h1>{detail.event.name}</h1><p className="employee-event-subtitle">{formatDate(detail.event.start_date)} – {formatDate(detail.event.end_date)}</p><p className="employee-event-location"><MapPin size={16} />{detail.event.location || translateUi('ไม่ระบุสถานที่')}</p></div>{!ended ? <button className="secondary-button" disabled={busy || detailLoading} onClick={startBooth} type="button"><Plus size={18} />{translateUi('เพิ่มบูธ')}</button> : null}</header>
          {ended ? <Notice>{translateUi('งานจบแล้ว ดูข้อมูลได้ · สิ้นสุด ')}{formatDate(detail.event.end_date)}</Notice> : null}
          <div className="employee-event-booth-tools">
            <SearchField label={translateUi('ค้นหาบูธ')} placeholder={translateUi('ค้นหาเลขบูธหรือชื่อร้าน')} value={boothQuery} onChange={setBoothQuery} />
            <div className="employee-event-filter-row"><label><span className="sr-only">{translateUi('กรองโซน')}</span><select aria-label={translateUi('กรองโซน')} onChange={(event) => setZone(event.target.value)} value={zone}><option value="">{translateUi('ทุกโซน')}</option>{zones.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><span>{filteredBooths.length} / {detail.booths.length}{translateUi(' บูธ')}</span>{boothQuery || zone ? <button className="employee-event-text-button" onClick={resetFilters} type="button">{translateUi('ล้างตัวกรอง')}</button> : null}</div>
          </div>
          {success ? <Notice success floating={!success.booth} action={<button aria-label={translateUi('ปิดข้อความสำเร็จ')} className="employee-event-icon-button" onClick={() => setSuccess(null)} type="button"><X size={18} /></button>}><span>{translateUi(success.message, success.values)}</span>{success.booth && !handoffIssue(detail.event, success.booth, today) ? <button className="employee-event-text-button" disabled={busy || detailLoading} onClick={() => openHandoff(success.booth!)} type="button">{translateUi('ส่งถังให้บูธนี้')}</button> : null}</Notice> : null}
          <div className="employee-event-booths" aria-label={translateUi('บูธในงาน')}>{filteredBooths.map((booth) => {
            const issue = handoffIssue(detail.event, booth, today);
            return <article aria-label={translateUi('บูธ {0} {1}', { 0: booth.booth_number, 1: booth.shop_name })} className={highlightedBooth === booth.id ? 'is-highlighted' : undefined} key={booth.id}><span className="employee-event-booth-number"><small>{translateUi('บูธ')}</small>{booth.booth_number}</span><div className="employee-event-booth-info"><strong>{booth.shop_name}</strong><span>{booth.event_zone || translateUi('ไม่ระบุโซน')}</span><p>{translateUi('ถังอยู่ที่ร้าน ')}<b>{booth.tank_balance.toLocaleString('th-TH')}{translateUi(' ใบ')}</b></p><small>{translateUi('ส่ง ')}{booth.tank_handoff_count.toLocaleString('th-TH')}{translateUi(' ใบ · รับคืน ')}{booth.tank_return_count.toLocaleString('th-TH')}{translateUi(' ใบ')}</small></div>{issue ? <span className="employee-event-unavailable">{translateUi(issue)}</span> : <button aria-label={translateUi('ส่งถัง บูธ {0}', { 0: booth.booth_number })} className="primary-button employee-event-handoff" disabled={busy || detailLoading} onClick={() => openHandoff(booth)} type="button">{translateUi('ส่งถัง')}<CaretRight size={18} /></button>}</article>;
          })}</div>
          {filteredBooths.length === 0 ? <div className="employee-event-empty"><Storefront size={34} /><h2>{detail.booths.length === 0 ? translateUi('งานนี้ยังไม่มีบูธ') : translateUi('ไม่พบบูธที่ค้นหา')}</h2><p>{detail.booths.length === 0 ? translateUi('เมื่อมีบูธแล้ว จะแสดงรายชื่อและยอดถังที่นี่') : translateUi('ลองเปลี่ยนเลขบูธ ชื่อร้าน หรือโซน')}</p>{detail.booths.length === 0 && !ended ? <button className="secondary-button" disabled={busy || detailLoading} onClick={startBooth} type="button"><Plus size={18} />{translateUi('เพิ่มบูธแรก')}</button> : boothQuery || zone ? <button className="secondary-button" onClick={resetFilters} type="button">{translateUi('ล้างตัวกรอง')}</button> : null}</div> : null}
        </> : null}
      </>}

      {boothDraft && detail && isActive ? <EmployeeEventDialog title={translateUi('เพิ่มบูธ')} context={detail.event.name} busy={busy} onClose={closeForm} onSubmit={(event) => void saveBooth(event)} submitLabel={translateUi('บันทึกบูธ')}>
        <label><span>{translateUi('เลขบูธ *')}</span><input data-initial-focus required disabled={busy} value={boothDraft.boothNumber} onChange={(event) => setBoothDraft({ ...boothDraft, boothNumber: event.target.value })} placeholder={translateUi('เช่น A01')} /></label>
        <label><span>{translateUi('ชื่อร้าน')}</span><input disabled={busy} value={boothDraft.shopName} onChange={(event) => setBoothDraft({ ...boothDraft, shopName: event.target.value })} placeholder={translateUi('เว้นว่างเพื่อใช้ “บูธ {0}”', { 0: boothDraft.boothNumber || '…' })} /></label>
        <label><span>{translateUi('โซน')}</span><input disabled={busy} list="employee-event-zones" value={boothDraft.eventZone} onChange={(event) => setBoothDraft({ ...boothDraft, eventZone: event.target.value })} placeholder={translateUi('เลือกหรือพิมพ์ชื่อโซน')} /><datalist id="employee-event-zones">{zones.map((value) => <option key={value} value={value} />)}</datalist></label>
        <details className="employee-event-contact"><summary>{translateUi('รายละเอียดติดต่อ (ไม่บังคับ)')}</summary><label><span>{translateUi('ชื่อผู้ติดต่อ')}</span><input disabled={busy} value={boothDraft.contactName} onChange={(event) => setBoothDraft({ ...boothDraft, contactName: event.target.value })} /></label><label><span>{translateUi('เบอร์โทร')}</span><input disabled={busy} inputMode="tel" value={boothDraft.contactPhone} onChange={(event) => setBoothDraft({ ...boothDraft, contactPhone: event.target.value })} /></label></details>
        {actionError ? <p className="employee-event-form-error" role="alert">{translateUi(actionError)}</p> : null}
      </EmployeeEventDialog> : null}
      {handoffDraft && detail && isActive ? <EmployeeEventDialog title={translateUi('ส่งถัง · บูธ {0}', { 0: handoffDraft.booth.booth_number })} context={`${detail.event.name} · ${handoffDraft.booth.shop_name}`} busy={busy} onClose={closeForm} onSubmit={(event) => void saveHandoff(event)} submitLabel={translateUi('ยืนยันส่งถัง')}>
        <div className="employee-tank-summary"><span>{translateUi('ถังอยู่ที่ร้าน')}<strong>{handoffDraft.booth.tank_balance}{translateUi(' ใบ')}</strong></span><span>{translateUi('ราคาต่อถัง')}<strong>{handoffDraft.booth.tank_rental_unit_price.toLocaleString('th-TH')}{translateUi(' บาท')}</strong></span></div>
        <label><span>{translateUi('จำนวนถังที่ส่งเพิ่ม (ใบ) *')}</span><div className="employee-tank-stepper"><button aria-label={translateUi('ลดจำนวนถัง')} disabled={busy || handoffQuantity <= 1} onClick={() => setHandoffDraft({ ...handoffDraft, quantity: String(Math.max(1, handoffQuantity - 1)) })} type="button"><Minus size={22} /></button><input aria-label={translateUi('จำนวนถัง')} required disabled={busy} min="1" max="10000" step="1" inputMode="numeric" type="number" value={handoffDraft.quantity} onChange={(event) => setHandoffDraft({ ...handoffDraft, quantity: event.target.value })} /><button aria-label={translateUi('เพิ่มจำนวนถัง')} disabled={busy || handoffQuantity >= 10000} onClick={() => setHandoffDraft({ ...handoffDraft, quantity: String(Math.min(10000, handoffQuantity + 1)) })} type="button"><Plus size={22} /></button></div></label>
        <div className="employee-tank-total" aria-live="polite"><span>{translateUi('ค่าเช่าครั้งนี้')}<strong>{(Math.max(0, handoffQuantity) * handoffDraft.booth.tank_rental_unit_price).toLocaleString('th-TH')}{translateUi(' บาท')}</strong></span><span>{translateUi('ถังอยู่ที่ร้านหลังส่ง')}<strong>{(handoffDraft.booth.tank_balance + Math.max(0, handoffQuantity)).toLocaleString('th-TH')}{translateUi(' ใบ')}</strong></span></div>
        <details className="employee-event-contact"><summary>{translateUi('เพิ่มหมายเหตุ (ไม่บังคับ)')}</summary><label><span>{translateUi('หมายเหตุ')}</span><input disabled={busy} value={handoffDraft.note} onChange={(event) => setHandoffDraft({ ...handoffDraft, note: event.target.value })} /></label></details>
        {actionError ? <p className="employee-event-form-error" role="alert">{translateUi(actionError)}</p> : null}
      </EmployeeEventDialog> : null}
    </section>
  );
}

function SearchField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  useLanguage();
  return <div className="employee-event-search"><MagnifyingGlass aria-hidden="true" size={22} /><input aria-label={label} placeholder={placeholder} type="search" value={value} onChange={(event) => onChange(event.target.value)} />{value ? <button aria-label={translateUi('ล้าง{0}', { 0: label })} onClick={() => onChange('')} type="button"><X size={19} /></button> : null}</div>;
}
function Notice({ children, error, success, floating, action }: { children: ReactNode; error?: boolean; success?: boolean; floating?: boolean; action?: ReactNode }) {
  useLanguage();
  return <div className={`employee-event-notice${error ? ' employee-event-notice--error' : success ? ' employee-event-notice--success' : ''}${floating ? ' employee-event-notice--toast' : ''}`} role={error ? 'alert' : success ? 'status' : undefined}>{error ? <WarningCircle size={21} /> : success ? <CheckCircle size={21} /> : <CalendarBlank size={21} />}<div>{children}</div>{action}</div>;
}
function LoadingState({ text }: { text: string }) {
  useLanguage();
  return <div className="employee-event-empty" role="status"><CircleNotch className="event-spin" size={30} /><p>{text}</p></div>;
}

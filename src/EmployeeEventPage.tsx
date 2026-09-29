import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarBlank,
  CheckCircle,
  CircleNotch,
  MagnifyingGlass,
  MapPin,
  Minus,
  Plus,
  Storefront,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { employeeEventGateway } from './features/employee-events/employeeEventGateway';
import type {
  EmployeeEventBooth,
  EmployeeEventDetail,
  EmployeeEventGateway,
  EmployeeEventSummary,
} from './features/employee-events/types';
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
  quantity: number;
  note: string;
  requestId: string;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${value}T12:00:00+07:00`));
}

function emptyBoothDraft(): BoothDraft {
  return {
    boothNumber: '',
    shopName: '',
    eventZone: '',
    contactName: '',
    contactPhone: '',
    requestId: crypto.randomUUID(),
  };
}

export function EmployeeEventPage({
  gateway = employeeEventGateway,
  isActive = true,
}: {
  gateway?: EmployeeEventGateway;
  isActive?: boolean;
}) {
  const [events, setEvents] = useState<EmployeeEventSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmployeeEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventQuery, setEventQuery] = useState('');
  const [boothQuery, setBoothQuery] = useState('');
  const [zone, setZone] = useState('');
  const [boothDraft, setBoothDraft] = useState<BoothDraft | null>(null);
  const [handoffDraft, setHandoffDraft] = useState<HandoffDraft | null>(null);
  const [busy, setBusy] = useState<'booth' | 'handoff' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; booth?: EmployeeEventBooth } | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (preferredId?: string | null) => {
    if (!isActive) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextEvents = await gateway.loadEvents();
      if (sequence !== requestSequence.current) return;
      setEvents(nextEvents);
      const nextId = preferredId && nextEvents.some((event) => event.id === preferredId)
        ? preferredId
        : selectedId && nextEvents.some((event) => event.id === selectedId)
          ? selectedId
          : nextEvents[0]?.id ?? null;
      setSelectedId(nextId);
      if (!nextId) {
        setDetail(null);
        return;
      }
      setDetailLoading(true);
      const nextDetail = await gateway.loadEvent(nextId);
      if (sequence === requestSequence.current) setDetail(nextDetail);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : 'โหลดงานอีเวนต์ไม่สำเร็จ');
      setDetail(null);
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setDetailLoading(false);
      }
    }
  }, [gateway, isActive, selectedId]);

  useEffect(() => {
    if (isActive) void load();
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseEvent = async (eventId: string) => {
    if (busy || (eventId === selectedId && detail)) return;
    const sequence = ++requestSequence.current;
    setSelectedId(eventId);
    setDetail(null);
    setSuccess(null);
    setBoothDraft(null);
    setHandoffDraft(null);
    setDetailLoading(true);
    setActionError(null);
    setBoothQuery('');
    setZone('');
    try {
      const nextDetail = await gateway.loadEvent(eventId);
      if (sequence === requestSequence.current) setDetail(nextDetail);
    } catch (loadError) {
      if (sequence === requestSequence.current) setActionError(loadError instanceof Error ? loadError.message : 'โหลดรายละเอียดไม่สำเร็จ');
    } finally {
      if (sequence === requestSequence.current) setDetailLoading(false);
    }
  };

  const filteredEvents = useMemo(() => {
    const query = eventQuery.trim().toLocaleLowerCase('th');
    return events.filter((event) => !query || `${event.name} ${event.location}`.toLocaleLowerCase('th').includes(query));
  }, [eventQuery, events]);

  const zones = useMemo(() => Array.from(new Set((detail?.booths ?? [])
    .map((booth) => booth.event_zone)
    .filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, 'th', { numeric: true })), [detail]);

  const filteredBooths = useMemo(() => {
    const query = boothQuery.trim().toLocaleLowerCase('th');
    return (detail?.booths ?? []).filter((booth) => (
      (!zone || booth.event_zone === zone)
      && (!query || `${booth.booth_number} ${booth.shop_name} ${booth.event_zone ?? ''}`.toLocaleLowerCase('th').includes(query))
    ));
  }, [boothQuery, detail, zone]);

  const saveBooth = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!boothDraft || !detail || !boothDraft.boothNumber.trim()) return;
    setBusy('booth');
    setActionError(null);
    try {
      const result = await gateway.createBooth({
        eventJobId: detail.event.id,
        requestId: boothDraft.requestId,
        boothNumber: boothDraft.boothNumber.trim(),
        shopName: boothDraft.shopName.trim(),
        eventZone: boothDraft.eventZone.trim(),
        contactName: boothDraft.contactName.trim(),
        contactPhone: boothDraft.contactPhone.trim(),
      });
      setBoothDraft(null);
      setSuccess({
        message: result.duplicate ? 'บูธนี้มีอยู่แล้ว เปิดบูธเดิมให้แล้ว' : 'เพิ่มบูธแล้ว',
        booth: result.booth,
      });
      await load(detail.event.id);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : 'เพิ่มบูธไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  };

  const saveHandoff = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!handoffDraft || handoffDraft.quantity < 1) return;
    setBusy('handoff');
    setActionError(null);
    try {
      await gateway.handoffTanks({
        participationId: handoffDraft.booth.id,
        quantity: handoffDraft.quantity,
        note: handoffDraft.note.trim(),
        requestId: handoffDraft.requestId,
      });
      const eventId = handoffDraft.booth.event_job_id;
      setHandoffDraft(null);
      setSuccess({ message: `บันทึกส่งถัง ${handoffDraft.quantity} ใบแล้ว` });
      await load(eventId);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : 'บันทึกส่งถังไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  };

  const openHandoff = (booth: EmployeeEventBooth) => {
    setActionError(null);
    setSuccess(null);
    setHandoffDraft({ booth, quantity: 1, note: '', requestId: crypto.randomUUID() });
  };

  if (loading && events.length === 0) return <EmployeeEventState icon={<CircleNotch className="event-spin" size={28} />} title="กำลังโหลดงานอีเวนต์" />;
  if (error && events.length === 0) return <EmployeeEventState icon={<WarningCircle size={30} />} title={error} action={<button className="primary-button" onClick={() => void load()} type="button">ลองอีกครั้ง</button>} />;

  const today = toBangkokDateString();
  const eventEnded = Boolean(detail && today > detail.event.end_date);
  const canHandoff = (booth: EmployeeEventBooth) => Boolean(detail
    && booth.event_job_id === detail.event.id
    && today >= (detail.event.preparation_start_date ?? detail.event.start_date)
    && today <= detail.event.end_date
    && today >= (booth.preparation_start_date ?? booth.start_date)
    && today <= booth.end_date);

  return (
    <section className="employee-event-page">
      <header className="employee-event-heading">
        <div><p className="eyebrow">งานที่เผยแพร่แล้ว</p><h1>อีเวนต์</h1></div>
        {detail && !eventEnded ? <button className="primary-button" onClick={() => { setActionError(null); setSuccess(null); setBoothDraft(emptyBoothDraft()); }} type="button"><Plus size={18} />เพิ่มบูธ</button> : null}
      </header>

      {success ? <div className="event-feedback event-feedback--success" role="status"><CheckCircle size={19} />{success.message}{success.booth && canHandoff(success.booth) ? <button onClick={() => openHandoff(success.booth!)} type="button">ส่งถังให้บูธนี้</button> : null}<button aria-label="ปิดข้อความ" onClick={() => setSuccess(null)} type="button"><X size={15} /></button></div> : null}
      {actionError && !boothDraft && !handoffDraft ? <div className="event-feedback event-feedback--error" role="alert"><WarningCircle size={19} />{actionError}</div> : null}

      <label className="event-search employee-event-search"><MagnifyingGlass size={18} /><span className="sr-only">ค้นหางาน</span><input onChange={(event) => setEventQuery(event.target.value)} placeholder="ค้นหาชื่องานหรือสถานที่" value={eventQuery} /></label>
      <div className="employee-event-selector" role="list" aria-label="เลือกงานอีเวนต์">
        {filteredEvents.map((event) => <button aria-current={selectedId === event.id ? 'true' : undefined} key={event.id} onClick={() => void chooseEvent(event.id)} type="button"><strong>{event.name}</strong><span><CalendarBlank size={14} />{formatDate(event.start_date)}–{formatDate(event.end_date)}</span><span><MapPin size={14} />{event.location || 'ไม่ระบุสถานที่'}</span><small>{event.active_participation_count} บูธ</small></button>)}
        {filteredEvents.length === 0 ? <p>ไม่พบงานอีเวนต์</p> : null}
      </div>

      {detailLoading ? <div className="event-detail-loading"><CircleNotch className="event-spin" size={24} />กำลังโหลดรายละเอียด</div> : null}
      {!detailLoading && detail ? <div className="employee-event-detail">
        <header><div><p>{formatDate(detail.event.start_date)}–{formatDate(detail.event.end_date)}</p><h2>{detail.event.name}</h2><span><MapPin size={16} />{detail.event.location || 'ไม่ระบุสถานที่'}</span></div>{eventEnded ? <strong className="event-status event-status--ended">จบงาน</strong> : null}</header>
        <div className="employee-event-booth-tools">
          <label className="event-search"><MagnifyingGlass size={18} /><span className="sr-only">ค้นหาบูธ</span><input onChange={(event) => setBoothQuery(event.target.value)} placeholder="ค้นหาเลขบูธหรือชื่อร้าน" value={boothQuery} /></label>
          <label><span className="sr-only">กรองโซน</span><select onChange={(event) => setZone(event.target.value)} value={zone}><option value="">ทุกโซน</option>{zones.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <div className="employee-event-booths">
          {filteredBooths.map((booth) => <article key={booth.id}>
            <span className="employee-event-booth-number">{booth.booth_number}</span>
            <div><strong>{booth.shop_name}</strong><small>{booth.event_zone || 'ไม่ระบุโซน'}</small><p>ส่งแล้ว {booth.tank_handoff_count} · รับคืน {booth.tank_return_count} · <strong>คงเหลือ {booth.tank_balance}</strong></p></div>
            {canHandoff(booth) ? <button className="secondary-button" onClick={() => openHandoff(booth)} type="button">ส่งเพิ่มถัง</button> : null}
          </article>)}
          {filteredBooths.length === 0 ? <div className="event-participation-empty"><Storefront size={28} /><p>{detail.booths.length === 0 ? 'งานนี้ยังไม่มีบูธ' : 'ไม่พบบูธตามที่ค้นหา'}</p>{!eventEnded ? <button onClick={() => setBoothDraft(emptyBoothDraft())} type="button">เพิ่มบูธแรก</button> : null}</div> : null}
        </div>
      </div> : null}

      {boothDraft && detail ? <div className="event-modal-layer" role="dialog" aria-modal="true" aria-labelledby="employee-booth-title">
        <button aria-label="ปิดหน้าต่าง" className="event-modal-backdrop" disabled={busy === 'booth'} onClick={() => setBoothDraft(null)} type="button" />
        <form className="event-modal event-modal--participant" onSubmit={(event) => void saveBooth(event)}>
          <header><div><p className="eyebrow">{detail.event.name}</p><h2 id="employee-booth-title">เพิ่มบูธ</h2></div><button aria-label="ปิด" disabled={busy === 'booth'} onClick={() => setBoothDraft(null)} type="button"><X size={20} /></button></header>
          <div className="event-modal__body"><div className="event-form-grid">
            <label><span>เลขบูธ *</span><input autoFocus required onChange={(event) => setBoothDraft({ ...boothDraft, boothNumber: event.target.value })} value={boothDraft.boothNumber} /></label>
            <label><span>ชื่อร้าน</span><input onChange={(event) => setBoothDraft({ ...boothDraft, shopName: event.target.value })} placeholder={`เว้นว่างเพื่อใช้ “บูธ ${boothDraft.boothNumber || '…'}”`} value={boothDraft.shopName} /></label>
            <label><span>โซน</span><input onChange={(event) => setBoothDraft({ ...boothDraft, eventZone: event.target.value })} value={boothDraft.eventZone} /></label>
          </div><details className="employee-event-contact"><summary>รายละเอียดติดต่อ</summary><div className="event-form-grid"><label><span>ชื่อผู้ติดต่อ</span><input onChange={(event) => setBoothDraft({ ...boothDraft, contactName: event.target.value })} value={boothDraft.contactName} /></label><label><span>เบอร์โทร</span><input inputMode="tel" onChange={(event) => setBoothDraft({ ...boothDraft, contactPhone: event.target.value })} value={boothDraft.contactPhone} /></label></div></details>
          {actionError ? <p className="event-form-error" role="alert"><WarningCircle size={17} />{actionError}</p> : null}</div>
          <footer><button className="secondary-button" disabled={busy === 'booth'} onClick={() => setBoothDraft(null)} type="button">ยกเลิก</button><button className="primary-button" disabled={busy === 'booth'} type="submit">{busy === 'booth' ? 'กำลังบันทึก...' : 'บันทึกบูธ'}</button></footer>
        </form>
      </div> : null}

      {handoffDraft ? <div className="event-modal-layer" role="dialog" aria-modal="true" aria-labelledby="employee-handoff-title">
        <button aria-label="ปิดหน้าต่าง" className="event-modal-backdrop" disabled={busy === 'handoff'} onClick={() => setHandoffDraft(null)} type="button" />
        <form className="event-modal event-modal--cancel" onSubmit={(event) => void saveHandoff(event)}>
          <header><div><p className="eyebrow">บูธ {handoffDraft.booth.booth_number}</p><h2 id="employee-handoff-title">ส่งเพิ่มถัง</h2></div><button aria-label="ปิด" disabled={busy === 'handoff'} onClick={() => setHandoffDraft(null)} type="button"><X size={20} /></button></header>
          <div className="event-modal__body"><div className="employee-tank-summary"><span>ถังคงเหลือเดิม<strong>{handoffDraft.booth.tank_balance}</strong></span><span>ราคาต่อถัง<strong>{handoffDraft.booth.tank_rental_unit_price.toLocaleString('th-TH')} บาท</strong></span></div>
          <label><span>จำนวนถัง *</span><div className="employee-tank-stepper"><button aria-label="ลดจำนวนถัง" onClick={() => setHandoffDraft({ ...handoffDraft, quantity: Math.max(1, handoffDraft.quantity - 1) })} type="button"><Minus size={20} /></button><input min="1" max="10000" inputMode="numeric" onChange={(event) => setHandoffDraft({ ...handoffDraft, quantity: Math.max(1, Number(event.target.value) || 1) })} type="number" value={handoffDraft.quantity} /><button aria-label="เพิ่มจำนวนถัง" onClick={() => setHandoffDraft({ ...handoffDraft, quantity: Math.min(10000, handoffDraft.quantity + 1) })} type="button"><Plus size={20} /></button></div></label>
          <p className="employee-tank-total">ค่าเช่าครั้งนี้ <strong>{(handoffDraft.quantity * handoffDraft.booth.tank_rental_unit_price).toLocaleString('th-TH')} บาท</strong></p>
          <label><span>หมายเหตุ</span><input onChange={(event) => setHandoffDraft({ ...handoffDraft, note: event.target.value })} value={handoffDraft.note} /></label>
          {actionError ? <p className="event-form-error" role="alert"><WarningCircle size={17} />{actionError}</p> : null}</div>
          <footer><button className="secondary-button" disabled={busy === 'handoff'} onClick={() => setHandoffDraft(null)} type="button">ยกเลิก</button><button className="primary-button" disabled={busy === 'handoff'} type="submit">{busy === 'handoff' ? 'กำลังบันทึก...' : 'ยืนยันส่งถัง'}</button></footer>
        </form>
      </div> : null}
    </section>
  );
}

function EmployeeEventState({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return <div className="event-page-state">{icon}<h1>{title}</h1>{action}</div>;
}

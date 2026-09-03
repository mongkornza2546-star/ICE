import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarBlank,
  CheckCircle,
  CircleNotch,
  MagnifyingGlass,
  MapPin,
  PencilSimple,
  Plus,
  Storefront,
  User,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { toBangkokDateString } from './lib/serviceDate';
import type { PaymentMethod } from './types/app';
import { eventManagementGateway } from './features/event-management/eventManagementGateway';
import type {
  EventConfiguration,
  EventJob,
  EventManagementDetail,
  EventManagementGateway,
  EventOverview,
  EventParticipation,
  EventShopOption,
} from './features/event-management/types';

type ManagerRole = 'admin' | 'round_lead';
type EventFilter = 'all' | 'draft' | 'published' | 'cancelled';
type BusyAction = 'event' | 'participation' | 'publish' | 'cancel' | null;

interface EventDraft {
  id: string | null;
  name: string;
  organizerName: string;
  contactName: string;
  contactPhone: string;
  location: string;
  startDate: string;
  endDate: string;
  notes: string;
  tankRentalUnitPrice: string;
  allowedPaymentMethods: PaymentMethod[];
  defaultPaymentMethod: PaymentMethod | '';
  cashReferenceRequired: boolean;
  cashEvidenceRequired: boolean;
  bankTransferReferenceRequired: boolean;
  bankTransferEvidenceRequired: boolean;
  qrReferenceRequired: boolean;
  qrEvidenceRequired: boolean;
}

interface ParticipationDraft {
  id: string | null;
  shopId: string;
  boothNumber: string;
  eventZone: string;
  landmark: string;
  contactName: string;
  contactPhone: string;
  startDate: string;
  endDate: string;
  rentsTankFromUs: boolean;
}

interface CancelTarget {
  kind: 'event' | 'participation';
  id: string;
  label: string;
}

const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'cash', label: 'เงินสด' },
  { value: 'bank_transfer', label: 'โอนธนาคาร' },
  { value: 'qr', label: 'QR' },
];
const PAYMENT_RULE_KEYS: Record<PaymentMethod, {
  reference: 'cashReferenceRequired' | 'bankTransferReferenceRequired' | 'qrReferenceRequired';
  evidence: 'cashEvidenceRequired' | 'bankTransferEvidenceRequired' | 'qrEvidenceRequired';
}> = {
  cash: { reference: 'cashReferenceRequired', evidence: 'cashEvidenceRequired' },
  bank_transfer: { reference: 'bankTransferReferenceRequired', evidence: 'bankTransferEvidenceRequired' },
  qr: { reference: 'qrReferenceRequired', evidence: 'qrEvidenceRequired' },
};

const READINESS_ISSUES: Record<string, string> = {
  inactive_shop: 'ร้านถูกปิดใช้งาน',
  missing_shop_code: 'ไม่มีรหัสร้าน',
  missing_shop_name: 'ไม่มีชื่อร้าน',
  missing_contact_name: 'ไม่มีชื่อผู้ติดต่อ',
  missing_contact_phone: 'ไม่มีเบอร์โทร',
  invalid_date_range: 'ช่วงวันที่ไม่อยู่ในช่วงงาน',
};

function emptyEventDraft(): EventDraft {
  const today = toBangkokDateString();
  return {
    id: null,
    name: '',
    organizerName: '',
    contactName: '',
    contactPhone: '',
    location: '',
    startDate: today,
    endDate: today,
    notes: '',
    tankRentalUnitPrice: '100',
    allowedPaymentMethods: [],
    defaultPaymentMethod: '',
    cashReferenceRequired: false,
    cashEvidenceRequired: false,
    bankTransferReferenceRequired: true,
    bankTransferEvidenceRequired: false,
    qrReferenceRequired: true,
    qrEvidenceRequired: false,
  };
}

function eventDraftFrom(job: EventJob, configuration: EventConfiguration | null): EventDraft {
  return {
    ...emptyEventDraft(),
    id: job.id,
    name: job.name,
    organizerName: job.organizer_name,
    contactName: job.contact_name,
    contactPhone: job.contact_phone,
    location: job.location,
    startDate: job.start_date,
    endDate: job.end_date,
    notes: job.notes ?? '',
    tankRentalUnitPrice: String(configuration?.tank_rental_unit_price ?? 100),
    allowedPaymentMethods: configuration?.allowed_payment_methods ?? [],
    defaultPaymentMethod: configuration?.default_payment_method ?? '',
    cashReferenceRequired: configuration?.cash_reference_required ?? false,
    cashEvidenceRequired: configuration?.cash_evidence_required ?? false,
    bankTransferReferenceRequired: configuration?.bank_transfer_reference_required ?? true,
    bankTransferEvidenceRequired: configuration?.bank_transfer_evidence_required ?? false,
    qrReferenceRequired: configuration?.qr_reference_required ?? true,
    qrEvidenceRequired: configuration?.qr_evidence_required ?? false,
  };
}

function participationDraftFrom(event: EventJob, participation?: EventParticipation): ParticipationDraft {
  return {
    id: participation?.id ?? null,
    shopId: participation?.shop_id ?? '',
    boothNumber: participation?.booth_number ?? '',
    eventZone: participation?.event_zone ?? '',
    landmark: participation?.landmark ?? '',
    contactName: participation?.contact_name ?? '',
    contactPhone: participation?.contact_phone ?? '',
    startDate: participation?.start_date ?? event.start_date,
    endDate: participation?.end_date ?? event.end_date,
    rentsTankFromUs: participation?.rents_tank_from_us ?? false,
  };
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(`${date}T12:00:00+07:00`));
}

function displayStatus(job: EventJob) {
  if (job.status === 'cancelled') return { label: 'ยกเลิก', tone: 'cancelled' };
  if (job.status === 'draft') return { label: 'ฉบับร่าง', tone: 'draft' };
  const today = toBangkokDateString();
  if (today < job.start_date) return { label: 'กำลังจะเริ่ม', tone: 'upcoming' };
  if (today > job.end_date) return { label: 'จบงาน', tone: 'ended' };
  return { label: 'กำลังจัดงาน', tone: 'active' };
}

function paymentLabel(method: PaymentMethod) {
  return PAYMENT_METHODS.find((option) => option.value === method)?.label ?? method;
}

function useModalLock(open: boolean, busy: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [busy, close, open]);
}

export function EventManagementPage({
  gateway = eventManagementGateway,
  isActive = true,
  profileRole,
}: {
  gateway?: EventManagementGateway;
  isActive?: boolean;
  profileRole: ManagerRole;
}) {
  const [events, setEvents] = useState<EventOverview[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventManagementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<EventFilter>('all');
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  const [participationDraft, setParticipationDraft] = useState<ParticipationDraft | null>(null);
  const [shops, setShops] = useState<EventShopOption[] | null>(null);
  const [shopQuery, setShopQuery] = useState('');
  const [shopLoading, setShopLoading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const loadRequest = useRef(0);

  const loadPage = useCallback(async (preferredId?: string | null) => {
    if (!isActive) return;
    const requestId = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      const capability = await gateway.loadCapability();
      if (!capability.lifecycle_enabled) throw new Error('ระบบจัดการอีเวนต์ยังไม่เปิดใช้งาน');
      const nextEvents = await gateway.loadOverview();
      if (requestId !== loadRequest.current) return;
      setEvents(nextEvents);
      const nextSelectedId = preferredId && nextEvents.some((event) => event.id === preferredId)
        ? preferredId
        : selectedId && nextEvents.some((event) => event.id === selectedId)
          ? selectedId
          : nextEvents[0]?.id ?? null;
      setSelectedId(nextSelectedId);
      if (!nextSelectedId) {
        setDetail(null);
        return;
      }
      setDetailLoading(true);
      const nextDetail = await gateway.loadDetail(nextSelectedId);
      if (requestId === loadRequest.current) setDetail(nextDetail);
    } catch (loadError) {
      if (requestId !== loadRequest.current) return;
      setEvents([]);
      setDetail(null);
      setError(loadError instanceof Error ? loadError.message : 'โหลดงานอีเวนต์ไม่สำเร็จ');
    } finally {
      if (requestId === loadRequest.current) {
        setLoading(false);
        setDetailLoading(false);
      }
    }
  }, [gateway, isActive, selectedId]);

  useEffect(() => {
    if (isActive) void loadPage();
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseEvent = async (eventId: string) => {
    if (eventId === selectedId && detail) return;
    const requestId = ++loadRequest.current;
    setSelectedId(eventId);
    setDetailLoading(true);
    setActionError(null);
    try {
      const nextDetail = await gateway.loadDetail(eventId);
      if (requestId === loadRequest.current) setDetail(nextDetail);
    } catch (loadError) {
      if (requestId === loadRequest.current) {
        setDetail(null);
        setActionError(loadError instanceof Error ? loadError.message : 'โหลดรายละเอียดงานไม่สำเร็จ');
      }
    } finally {
      if (requestId === loadRequest.current) setDetailLoading(false);
    }
  };

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('th');
    return events.filter((event) => (
      (filter === 'all' || event.status === filter)
      && (!normalizedQuery || [event.name, event.organizer_name, event.location]
        .some((value) => value.toLocaleLowerCase('th').includes(normalizedQuery)))
    ));
  }, [events, filter, query]);

  const availableShops = useMemo(() => {
    if (!shops) return [];
    const usedShopIds = new Set(detail?.participations.map((participation) => participation.shop_id));
    const normalizedQuery = shopQuery.trim().toLocaleLowerCase('th');
    return shops.filter((shop) => (
      (!usedShopIds.has(shop.id) || shop.id === participationDraft?.shopId)
      && (!normalizedQuery || `${shop.code} ${shop.name}`.toLocaleLowerCase('th').includes(normalizedQuery))
    )).slice(0, 40);
  }, [detail?.participations, participationDraft?.shopId, shopQuery, shops]);

  const openEventEditor = (job?: EventJob) => {
    setActionError(null);
    setEventDraft(job ? eventDraftFrom(job, detail?.configuration ?? null) : emptyEventDraft());
  };

  const closeEventEditor = useCallback(() => {
    if (busyAction) return;
    setEventDraft(null);
    setActionError(null);
  }, [busyAction]);

  const openParticipationEditor = async (participation?: EventParticipation) => {
    if (!detail) return;
    setActionError(null);
    setShopQuery('');
    setParticipationDraft(participationDraftFrom(detail.event, participation));
    if (!participation && !shops) {
      setShopLoading(true);
      try {
        setShops(await gateway.loadActiveShops());
      } catch (loadError) {
        setActionError(loadError instanceof Error ? loadError.message : 'โหลดรายชื่อร้านไม่สำเร็จ');
      } finally {
        setShopLoading(false);
      }
    }
  };

  const closeParticipationEditor = useCallback(() => {
    if (busyAction) return;
    setParticipationDraft(null);
    setActionError(null);
  }, [busyAction]);

  const closeCancelModal = useCallback(() => {
    if (busyAction) return;
    setCancelTarget(null);
    setCancelReason('');
    setActionError(null);
  }, [busyAction]);

  useModalLock(Boolean(eventDraft), busyAction === 'event', closeEventEditor);
  useModalLock(Boolean(participationDraft), busyAction === 'participation', closeParticipationEditor);
  useModalLock(Boolean(cancelTarget), busyAction === 'cancel', closeCancelModal);

  const saveEvent = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!eventDraft) return;
    setActionError(null);
    if (!eventDraft.name.trim() || !eventDraft.organizerName.trim() || !eventDraft.contactName.trim()
      || !eventDraft.contactPhone.trim() || !eventDraft.location.trim()) {
      setActionError('กรอกชื่องาน ผู้จัด ผู้ติดต่อ เบอร์โทร และสถานที่ให้ครบ');
      return;
    }
    if (!eventDraft.startDate || !eventDraft.endDate || eventDraft.endDate < eventDraft.startDate) {
      setActionError('ช่วงวันที่จัดงานไม่ถูกต้อง');
      return;
    }
    if (profileRole === 'admin' && (
      Number(eventDraft.tankRentalUnitPrice) <= 0
      || eventDraft.allowedPaymentMethods.length === 0
      || !eventDraft.defaultPaymentMethod
      || !eventDraft.allowedPaymentMethods.includes(eventDraft.defaultPaymentMethod)
    )) {
      setActionError('กำหนดค่า config และเลือกวิธีรับเงินเริ่มต้นให้ครบ');
      return;
    }

    setBusyAction('event');
    try {
      const metadata = {
        event_job_id: eventDraft.id,
        name: eventDraft.name.trim(),
        organizer_name: eventDraft.organizerName.trim(),
        contact_name: eventDraft.contactName.trim(),
        contact_phone: eventDraft.contactPhone.trim(),
        location: eventDraft.location.trim(),
        start_date: eventDraft.startDate,
        end_date: eventDraft.endDate,
        notes: eventDraft.notes.trim(),
      };
      const saved = profileRole === 'admin'
        ? (await gateway.saveEvent({
            ...metadata,
            tank_rental_unit_price: Number(eventDraft.tankRentalUnitPrice),
            allowed_payment_methods: eventDraft.allowedPaymentMethods,
            default_payment_method: eventDraft.defaultPaymentMethod as PaymentMethod,
            cash_reference_required: eventDraft.cashReferenceRequired,
            cash_evidence_required: eventDraft.cashEvidenceRequired,
            bank_transfer_reference_required: eventDraft.bankTransferReferenceRequired,
            bank_transfer_evidence_required: eventDraft.bankTransferEvidenceRequired,
            qr_reference_required: eventDraft.qrReferenceRequired,
            qr_evidence_required: eventDraft.qrEvidenceRequired,
          })).event_job
        : await gateway.saveMetadata(metadata);
      setEventDraft(null);
      setSuccess(eventDraft.id ? 'บันทึกข้อมูลงานแล้ว' : 'สร้างงานอีเวนต์แล้ว');
      await loadPage(saved.id);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : 'บันทึกงานไม่สำเร็จ');
    } finally {
      setBusyAction(null);
    }
  };

  const saveParticipation = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!participationDraft || !detail) return;
    setActionError(null);
    if (!participationDraft.shopId) {
      setActionError('เลือกร้านที่เข้าร่วมงาน');
      return;
    }
    if (!participationDraft.startDate || !participationDraft.endDate
      || participationDraft.startDate < detail.event.start_date
      || participationDraft.endDate > detail.event.end_date
      || participationDraft.endDate < participationDraft.startDate) {
      setActionError('ช่วงวันที่ของร้านต้องอยู่ภายในช่วงงาน');
      return;
    }

    setBusyAction('participation');
    try {
      await gateway.saveParticipation({
        participation_id: participationDraft.id,
        event_job_id: detail.event.id,
        shop_id: participationDraft.shopId,
        booth_number: participationDraft.boothNumber.trim(),
        event_zone: participationDraft.eventZone.trim(),
        landmark: participationDraft.landmark.trim(),
        contact_name: participationDraft.contactName.trim(),
        contact_phone: participationDraft.contactPhone.trim(),
        start_date: participationDraft.startDate,
        end_date: participationDraft.endDate,
        rents_tank_from_us: participationDraft.rentsTankFromUs,
      });
      setParticipationDraft(null);
      setSuccess(participationDraft.id ? 'อัปเดตร้านในงานแล้ว' : 'เพิ่มร้านในงานแล้ว');
      await loadPage(detail.event.id);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : 'บันทึกร้านไม่สำเร็จ');
    } finally {
      setBusyAction(null);
    }
  };

  const publishEvent = async () => {
    if (!detail?.readiness.is_ready) return;
    if (!window.confirm(`เผยแพร่ “${detail.event.name}” แล้วจะย้อนกลับเป็นฉบับร่างไม่ได้ ยืนยันหรือไม่?`)) return;
    setBusyAction('publish');
    setActionError(null);
    try {
      await gateway.publishEvent(detail.event.id);
      setSuccess('เผยแพร่งานอีเวนต์แล้ว');
      await loadPage(detail.event.id);
    } catch (publishError) {
      setActionError(publishError instanceof Error ? publishError.message : 'เผยแพร่งานไม่สำเร็จ');
      await loadPage(detail.event.id);
    } finally {
      setBusyAction(null);
    }
  };

  const cancel = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (!cancelTarget || !cancelReason.trim() || !detail) return;
    setBusyAction('cancel');
    setActionError(null);
    try {
      if (cancelTarget.kind === 'event') await gateway.cancelEvent(cancelTarget.id, cancelReason.trim());
      else await gateway.cancelParticipation(cancelTarget.id, cancelReason.trim());
      setCancelTarget(null);
      setCancelReason('');
      setSuccess(cancelTarget.kind === 'event' ? 'ยกเลิกงานอีเวนต์แล้ว' : 'ยกเลิกร้านในงานแล้ว');
      await loadPage(detail.event.id);
    } catch (cancelError) {
      setActionError(cancelError instanceof Error ? cancelError.message : 'ยกเลิกรายการไม่สำเร็จ');
    } finally {
      setBusyAction(null);
    }
  };

  if (loading && events.length === 0) {
    return <EventPageState icon={<CircleNotch className="event-spin" size={28} />} title="กำลังโหลดงานอีเวนต์" detail="ตรวจสอบสิทธิ์และข้อมูลล่าสุดจากระบบ" />;
  }

  if (error && events.length === 0) {
    return <EventPageState icon={<WarningCircle size={30} />} title="เปิดหน้างานอีเวนต์ไม่ได้" detail={error} action={<button className="primary-button" onClick={() => void loadPage()} type="button">ลองอีกครั้ง</button>} />;
  }

  return (
    <div className="event-management-page">
      <header className="event-management-heading">
        <div>
          <p className="eyebrow">Event lifecycle</p>
          <h1>งานอีเวนต์</h1>
          <p>สร้างงาน เพิ่มร้าน ตรวจความพร้อม และควบคุมการเผยแพร่</p>
        </div>
        <button className="primary-button" onClick={() => openEventEditor()} type="button"><Plus size={18} />สร้างงาน</button>
      </header>

      {success ? <div className="event-feedback event-feedback--success" role="status"><CheckCircle size={19} />{success}<button aria-label="ปิดข้อความ" onClick={() => setSuccess(null)} type="button"><X size={15} /></button></div> : null}
      {actionError && !eventDraft && !participationDraft && !cancelTarget ? <div className="event-feedback event-feedback--error" role="alert"><WarningCircle size={19} />{actionError}</div> : null}

      <div className="event-management-grid">
        <section className="event-browser" aria-label="รายการงานอีเวนต์">
          <div className="event-browser__tools">
            <label className="event-search"><MagnifyingGlass size={18} /><span className="sr-only">ค้นหางาน</span><input onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่องาน ผู้จัด สถานที่" value={query} /></label>
            <div className="event-filter-tabs" role="group" aria-label="กรองสถานะงาน">
              {([
                ['all', 'ทั้งหมด'],
                ['draft', 'ฉบับร่าง'],
                ['published', 'เผยแพร่'],
                ['cancelled', 'ยกเลิก'],
              ] as Array<[EventFilter, string]>).map(([value, label]) => (
                <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">{label}</button>
              ))}
            </div>
          </div>
          <div className="event-list">
            {filteredEvents.map((event) => {
              const status = displayStatus(event);
              return (
                <button aria-current={selectedId === event.id ? 'true' : undefined} className="event-list-card" key={event.id} onClick={() => void chooseEvent(event.id)} type="button">
                  <span className={`event-status event-status--${status.tone}`}>{status.label}</span>
                  <strong>{event.name}</strong>
                  <small><CalendarBlank size={14} />{formatDate(event.start_date)}–{formatDate(event.end_date)}</small>
                  <small><MapPin size={14} />{event.location}</small>
                  <span className="event-list-card__count"><Storefront size={15} />{event.active_participation_count} ร้าน</span>
                </button>
              );
            })}
            {filteredEvents.length === 0 ? <div className="event-empty-list"><CalendarBlank size={26} /><p>{events.length === 0 ? 'ยังไม่มีงานอีเวนต์' : 'ไม่พบงานตามตัวกรอง'}</p>{events.length === 0 ? <button onClick={() => openEventEditor()} type="button">สร้างงานแรก</button> : null}</div> : null}
          </div>
        </section>

        <section className="event-detail" aria-live="polite">
          {detailLoading ? <div className="event-detail-loading"><CircleNotch className="event-spin" size={26} />กำลังโหลดรายละเอียด</div> : null}
          {!detailLoading && detail ? (
            <EventDetail
              busyAction={busyAction}
              detail={detail}
              onAddParticipation={() => void openParticipationEditor()}
              onCancelEvent={() => { setActionError(null); setCancelTarget({ kind: 'event', id: detail.event.id, label: detail.event.name }); }}
              onCancelParticipation={(participation) => { setActionError(null); setCancelTarget({ kind: 'participation', id: participation.id, label: `${participation.shop_code} ${participation.shop_name}` }); }}
              onEditEvent={() => openEventEditor(detail.event)}
              onEditParticipation={(participation) => void openParticipationEditor(participation)}
              onPublish={() => void publishEvent()}
              profileRole={profileRole}
            />
          ) : null}
          {!detailLoading && !detail ? <div className="event-detail-placeholder"><CalendarBlank size={34} /><p>เลือกงานเพื่อดูรายละเอียด</p></div> : null}
        </section>
      </div>

      {eventDraft ? (
        <div className="event-modal-layer" role="dialog" aria-modal="true" aria-labelledby="event-editor-title">
          <button aria-label="ปิดหน้าต่าง" className="event-modal-backdrop" disabled={busyAction === 'event'} onClick={closeEventEditor} type="button" />
          <form className="event-modal" onSubmit={(event) => void saveEvent(event)}>
            <header><div><p className="eyebrow">{eventDraft.id ? 'แก้ไขฉบับร่าง' : 'งานใหม่'}</p><h2 id="event-editor-title">{eventDraft.id ? 'แก้ข้อมูลงานอีเวนต์' : 'สร้างงานอีเวนต์'}</h2></div><button aria-label="ปิด" disabled={busyAction === 'event'} onClick={closeEventEditor} type="button"><X size={20} /></button></header>
            <div className="event-modal__body">
              <fieldset><legend>ข้อมูลงาน</legend><div className="event-form-grid">
                <label className="event-field event-field--wide"><span>ชื่องาน *</span><input autoFocus onChange={(event) => setEventDraft({ ...eventDraft, name: event.target.value })} value={eventDraft.name} /></label>
                <label><span>ผู้จัดงาน *</span><input onChange={(event) => setEventDraft({ ...eventDraft, organizerName: event.target.value })} value={eventDraft.organizerName} /></label>
                <label><span>สถานที่ *</span><input onChange={(event) => setEventDraft({ ...eventDraft, location: event.target.value })} value={eventDraft.location} /></label>
                <label><span>ผู้ติดต่อหลัก *</span><input onChange={(event) => setEventDraft({ ...eventDraft, contactName: event.target.value })} value={eventDraft.contactName} /></label>
                <label><span>เบอร์โทร *</span><input inputMode="tel" onChange={(event) => setEventDraft({ ...eventDraft, contactPhone: event.target.value })} value={eventDraft.contactPhone} /></label>
                <label><span>วันเริ่ม *</span><input onChange={(event) => setEventDraft({ ...eventDraft, startDate: event.target.value })} type="date" value={eventDraft.startDate} /></label>
                <label><span>วันสิ้นสุด *</span><input min={eventDraft.startDate} onChange={(event) => setEventDraft({ ...eventDraft, endDate: event.target.value })} type="date" value={eventDraft.endDate} /></label>
                <label className="event-field event-field--wide"><span>หมายเหตุ</span><textarea onChange={(event) => setEventDraft({ ...eventDraft, notes: event.target.value })} rows={3} value={eventDraft.notes} /></label>
              </div></fieldset>

              {profileRole === 'admin' ? <EventConfigurationFields draft={eventDraft} onChange={setEventDraft} /> : <section className="event-lead-notice"><User size={20} /><div><strong>การตั้งค่าการชำระเงินเป็นสิทธิ์แอดมิน</strong><p>คุณสร้างงานและเพิ่มร้านได้ เมื่อแอดมินตั้งค่าแล้วจึงตรวจ readiness และเผยแพร่ได้</p></div></section>}
              {actionError ? <p className="event-form-error" role="alert"><WarningCircle size={17} />{actionError}</p> : null}
            </div>
            <footer><button className="secondary-button" disabled={busyAction === 'event'} onClick={closeEventEditor} type="button">ยกเลิก</button><button className="primary-button" disabled={busyAction === 'event'} type="submit">{busyAction === 'event' ? 'กำลังบันทึก...' : 'บันทึกงาน'}</button></footer>
          </form>
        </div>
      ) : null}

      {participationDraft && detail ? (
        <div className="event-modal-layer" role="dialog" aria-modal="true" aria-labelledby="participation-editor-title">
          <button aria-label="ปิดหน้าต่าง" className="event-modal-backdrop" disabled={busyAction === 'participation'} onClick={closeParticipationEditor} type="button" />
          <form className="event-modal event-modal--participant" onSubmit={(event) => void saveParticipation(event)}>
            <header><div><p className="eyebrow">ร้านที่เข้าร่วม</p><h2 id="participation-editor-title">{participationDraft.id ? 'แก้รายละเอียดร้าน' : 'เพิ่มร้านในงาน'}</h2></div><button aria-label="ปิด" disabled={busyAction === 'participation'} onClick={closeParticipationEditor} type="button"><X size={20} /></button></header>
            <div className="event-modal__body">
              {participationDraft.id ? <div className="event-selected-shop"><Storefront size={21} /><div><strong>{detail.participations.find((item) => item.id === participationDraft.id)?.shop_code} {detail.participations.find((item) => item.id === participationDraft.id)?.shop_name}</strong><small>{detail.event.status === 'published' ? 'เปลี่ยนร้านหลัง publish ไม่ได้' : 'ร้านที่เลือกไว้'}</small></div></div> : <div className="event-shop-picker">
                <label className="event-search"><MagnifyingGlass size={18} /><span className="sr-only">ค้นหาร้าน</span><input onChange={(event) => setShopQuery(event.target.value)} placeholder="ค้นหารหัสหรือชื่อร้าน" value={shopQuery} /></label>
                <div className="event-shop-results">
                  {shopLoading ? <p><CircleNotch className="event-spin" size={18} />กำลังโหลดร้าน</p> : availableShops.map((shop) => <button aria-pressed={participationDraft.shopId === shop.id} key={shop.id} onClick={() => setParticipationDraft({ ...participationDraft, shopId: shop.id })} type="button"><span><strong>{shop.code}</strong>{shop.name}</span><small>{shop.contact_name || shop.contact_phone ? [shop.contact_name, shop.contact_phone].filter(Boolean).join(' · ') : 'ยังไม่มีข้อมูลติดต่อร้าน'}</small></button>)}
                  {!shopLoading && availableShops.length === 0 ? <p>ไม่พบร้าน active ที่เพิ่มได้</p> : null}
                </div>
              </div>}
              <fieldset><legend>รายละเอียดในงาน</legend><div className="event-form-grid">
                <label><span>เลขบูธ</span><input onChange={(event) => setParticipationDraft({ ...participationDraft, boothNumber: event.target.value })} value={participationDraft.boothNumber} /></label>
                <label><span>โซน</span><input onChange={(event) => setParticipationDraft({ ...participationDraft, eventZone: event.target.value })} value={participationDraft.eventZone} /></label>
                <label className="event-field event-field--wide"><span>จุดสังเกต</span><input onChange={(event) => setParticipationDraft({ ...participationDraft, landmark: event.target.value })} value={participationDraft.landmark} /></label>
                <label><span>ผู้ติดต่อเฉพาะงาน</span><input onChange={(event) => setParticipationDraft({ ...participationDraft, contactName: event.target.value })} placeholder="เว้นว่างเพื่อใช้ข้อมูลร้าน" value={participationDraft.contactName} /></label>
                <label><span>เบอร์โทรเฉพาะงาน</span><input inputMode="tel" onChange={(event) => setParticipationDraft({ ...participationDraft, contactPhone: event.target.value })} placeholder="เว้นว่างเพื่อใช้ข้อมูลร้าน" value={participationDraft.contactPhone} /></label>
                <label><span>วันเริ่มขาย *</span><input min={detail.event.start_date} max={detail.event.end_date} onChange={(event) => setParticipationDraft({ ...participationDraft, startDate: event.target.value })} type="date" value={participationDraft.startDate} /></label>
                <label><span>วันสุดท้าย *</span><input min={participationDraft.startDate} max={detail.event.end_date} onChange={(event) => setParticipationDraft({ ...participationDraft, endDate: event.target.value })} type="date" value={participationDraft.endDate} /></label>
              </div></fieldset>
              {actionError ? <p className="event-form-error" role="alert"><WarningCircle size={17} />{actionError}</p> : null}
            </div>
            <footer><button className="secondary-button" disabled={busyAction === 'participation'} onClick={closeParticipationEditor} type="button">ยกเลิก</button><button className="primary-button" disabled={busyAction === 'participation'} type="submit">{busyAction === 'participation' ? 'กำลังบันทึก...' : 'บันทึกร้าน'}</button></footer>
          </form>
        </div>
      ) : null}

      {cancelTarget ? (
        <div className="event-modal-layer" role="dialog" aria-modal="true" aria-labelledby="event-cancel-title">
          <button aria-label="ปิดหน้าต่าง" className="event-modal-backdrop" disabled={busyAction === 'cancel'} onClick={closeCancelModal} type="button" />
          <form className="event-modal event-modal--cancel" onSubmit={(event) => void cancel(event)}>
            <header><div><p className="eyebrow">การกระทำนี้ย้อนกลับไม่ได้</p><h2 id="event-cancel-title">ยกเลิก{cancelTarget.kind === 'event' ? 'งาน' : 'ร้านในงาน'}</h2></div><button aria-label="ปิด" disabled={busyAction === 'cancel'} onClick={closeCancelModal} type="button"><X size={20} /></button></header>
            <div className="event-modal__body"><p>รายการ: <strong>{cancelTarget.label}</strong></p><label><span>เหตุผลในการยกเลิก *</span><textarea autoFocus onChange={(event) => setCancelReason(event.target.value)} rows={4} value={cancelReason} /></label>{actionError ? <p className="event-form-error" role="alert"><WarningCircle size={17} />{actionError}</p> : null}</div>
            <footer><button className="secondary-button" disabled={busyAction === 'cancel'} onClick={closeCancelModal} type="button">กลับ</button><button className="primary-button destructive-button" disabled={busyAction === 'cancel' || !cancelReason.trim()} type="submit">{busyAction === 'cancel' ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิก'}</button></footer>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function EventConfigurationFields({ draft, onChange }: { draft: EventDraft; onChange: (draft: EventDraft) => void }) {
  const toggleMethod = (method: PaymentMethod) => {
    const enabled = draft.allowedPaymentMethods.includes(method);
    const allowedPaymentMethods = enabled
      ? draft.allowedPaymentMethods.filter((value) => value !== method)
      : [...draft.allowedPaymentMethods, method];
    onChange({
      ...draft,
      allowedPaymentMethods,
      defaultPaymentMethod: enabled && draft.defaultPaymentMethod === method ? '' : draft.defaultPaymentMethod,
    });
  };
  return (
    <fieldset><legend>นโยบายการชำระเงิน · เฉพาะแอดมิน</legend><div className="event-form-grid">
      <label><span>ค่าเช่าถังใน config (บาท) *</span><input min="0.01" onChange={(event) => onChange({ ...draft, tankRentalUnitPrice: event.target.value })} step="0.01" type="number" value={draft.tankRentalUnitPrice} /></label>
      <label><span>เงื่อนไขชำระ</span><input disabled value="สิ้นวัน (end_of_day)" /></label>
      <div className="event-field event-field--wide"><span>วิธีรับเงินที่อนุญาต *</span><div className="event-check-grid">{PAYMENT_METHODS.map((method) => <label key={method.value}><input checked={draft.allowedPaymentMethods.includes(method.value)} onChange={() => toggleMethod(method.value)} type="checkbox" />{method.label}</label>)}</div></div>
      <label className="event-field event-field--wide"><span>วิธีรับเงินเริ่มต้น *</span><select onChange={(event) => onChange({ ...draft, defaultPaymentMethod: event.target.value as PaymentMethod | '' })} value={draft.defaultPaymentMethod}><option value="">เลือกวิธีเริ่มต้น</option>{draft.allowedPaymentMethods.map((method) => <option key={method} value={method}>{paymentLabel(method)}</option>)}</select></label>
      {draft.allowedPaymentMethods.map((method) => {
        const referenceKey = PAYMENT_RULE_KEYS[method].reference;
        const evidenceKey = PAYMENT_RULE_KEYS[method].evidence;
        return <div className="event-payment-rule event-field--wide" key={method}><strong>{paymentLabel(method)}</strong><label><input checked={draft[referenceKey]} onChange={(event) => onChange({ ...draft, [referenceKey]: event.target.checked })} type="checkbox" />ต้องมีเลขอ้างอิง</label><label><input checked={draft[evidenceKey]} onChange={(event) => onChange({ ...draft, [evidenceKey]: event.target.checked })} type="checkbox" />ต้องมีหลักฐาน</label></div>;
      })}
    </div></fieldset>
  );
}

function EventDetail({
  busyAction,
  detail,
  onAddParticipation,
  onCancelEvent,
  onCancelParticipation,
  onEditEvent,
  onEditParticipation,
  onPublish,
  profileRole,
}: {
  busyAction: BusyAction;
  detail: EventManagementDetail;
  onAddParticipation: () => void;
  onCancelEvent: () => void;
  onCancelParticipation: (participation: EventParticipation) => void;
  onEditEvent: () => void;
  onEditParticipation: (participation: EventParticipation) => void;
  onPublish: () => void;
  profileRole: ManagerRole;
}) {
  const { event, configuration, participations, readiness } = detail;
  const status = displayStatus(event);
  const activeParticipations = participations.filter((participation) => participation.status === 'active');
  return (
    <div className="event-detail__content">
      <header className="event-detail__header">
        <div><span className={`event-status event-status--${status.tone}`}>{status.label}</span><h2>{event.name}</h2><p>{event.organizer_name}</p></div>
        <div className="event-detail__actions">
          {event.status === 'draft' ? <button className="secondary-button" disabled={Boolean(busyAction)} onClick={onEditEvent} type="button"><PencilSimple size={16} />แก้ข้อมูลงาน</button> : null}
          {event.status === 'draft' ? <button className="primary-button" disabled={Boolean(busyAction) || !readiness.is_ready} onClick={onPublish} type="button">{busyAction === 'publish' ? 'กำลังเผยแพร่...' : 'Publish'}</button> : null}
          {event.status !== 'cancelled' ? <button className="event-danger-button" disabled={Boolean(busyAction)} onClick={onCancelEvent} type="button">ยกเลิกงาน</button> : null}
        </div>
      </header>

      <dl className="event-facts">
        <div><dt>วันที่จัดงาน</dt><dd>{formatDate(event.start_date)}–{formatDate(event.end_date)}</dd></div>
        <div><dt>สถานที่</dt><dd>{event.location}</dd></div>
        <div><dt>ผู้ติดต่อ</dt><dd>{event.contact_name} · {event.contact_phone}</dd></div>
        <div><dt>อัปเดตล่าสุด</dt><dd>{new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(event.updated_at))}</dd></div>
      </dl>
      {event.notes ? <p className="event-notes">{event.notes}</p> : null}

      {event.status === 'draft' ? <section className={`event-readiness ${readiness.is_ready ? 'event-readiness--ready' : ''}`}>
        <header><div><h3>ความพร้อมก่อน Publish</h3><p>{readiness.is_ready ? 'ตรวจครบทุกเงื่อนไขแล้ว' : 'แก้รายการที่ยังไม่พร้อมก่อนเผยแพร่'}</p></div><strong>{readiness.checks.filter((check) => check.ok).length}/{readiness.checks.length}</strong></header>
        <div className="event-readiness__checks">{readiness.checks.map((check) => <ReadinessCheck key={check.code} check={check} />)}</div>
      </section> : null}

      <section className="event-config-summary">
        <header><h3>นโยบายการชำระเงิน</h3>{profileRole === 'round_lead' ? <span>อ่านอย่างเดียว</span> : null}</header>
        {configuration ? <dl><div><dt>วิธีรับเงิน</dt><dd>{configuration.allowed_payment_methods.map(paymentLabel).join(', ')}</dd></div><div><dt>วิธีเริ่มต้น</dt><dd>{paymentLabel(configuration.default_payment_method)}</dd></div><div><dt>เงื่อนไข</dt><dd>ชำระสิ้นวัน</dd></div><div><dt>Config version</dt><dd>v{configuration.version_no}</dd></div></dl> : <p className="event-config-missing"><WarningCircle size={18} />รอแอดมินตั้งค่า config</p>}
      </section>

      <section className="event-participations">
        <header><div><h3>ร้านที่เข้าร่วม</h3><p>{activeParticipations.length} ร้านที่ใช้งาน</p></div>{event.status !== 'cancelled' && activeParticipations.length < 50 ? <button className="secondary-button" onClick={onAddParticipation} type="button"><Plus size={16} />เพิ่มร้าน</button> : null}</header>
        <div className="event-participation-list">
          {participations.map((participation) => <article className={participation.status === 'cancelled' ? 'is-cancelled' : ''} key={participation.id}>
            <span className="event-participation-icon"><Storefront size={21} /></span>
            <div><strong>{participation.shop_code} · {participation.shop_name}</strong><small>{[participation.booth_number && `บูธ ${participation.booth_number}`, participation.event_zone, participation.landmark].filter(Boolean).join(' · ') || 'ยังไม่ระบุบูธ/โซน'}</small><small>{formatDate(participation.start_date)}–{formatDate(participation.end_date)} · {participation.contact_name || participation.shop_contact_name || 'ไม่มีผู้ติดต่อ'} {participation.contact_phone || participation.shop_contact_phone || ''}</small>{participation.status === 'cancelled' ? <em>ยกเลิก: {participation.cancellation_reason}</em> : null}</div>
            {participation.status === 'active' && event.status !== 'cancelled' ? <div><button aria-label={`แก้ไข ${participation.shop_code} ${participation.shop_name}`} onClick={() => onEditParticipation(participation)} type="button"><PencilSimple size={16} /></button><button aria-label={`ยกเลิก ${participation.shop_code} ${participation.shop_name}`} onClick={() => onCancelParticipation(participation)} type="button"><X size={16} /></button></div> : null}
          </article>)}
          {participations.length === 0 ? <div className="event-participation-empty"><Storefront size={26} /><p>ยังไม่มีร้านในงานนี้</p><button onClick={onAddParticipation} type="button">เพิ่มร้านแรก</button></div> : null}
        </div>
      </section>

      {event.status === 'cancelled' ? <section className="event-cancelled-note"><WarningCircle size={20} /><div><strong>งานนี้ถูกยกเลิกแล้ว</strong><p>{event.cancellation_reason}</p></div></section> : null}
    </div>
  );
}

function ReadinessCheck({ check }: { check: EventManagementDetail['readiness']['checks'][number] }) {
  const items = Array.isArray(check.items) ? check.items : [];
  return <article className={check.ok ? 'is-ready' : 'has-issue'}>{check.ok ? <CheckCircle size={20} weight="fill" /> : <WarningCircle size={20} weight="fill" />}<div><strong>{check.message}</strong>{typeof check.actual === 'number' ? <small>ปัจจุบัน {check.actual} ร้าน</small> : null}{!check.ok && check.code === 'participation_details' ? items.map((item, index) => <small key={String(item.participation_id ?? index)}>{String(item.shop_code ?? '')} {String(item.shop_name ?? '')}: {(Array.isArray(item.issues) ? item.issues : []).map((issue) => READINESS_ISSUES[String(issue)] ?? String(issue)).join(', ')}</small>) : null}{!check.ok && check.code === 'standard_price_coverage' ? items.map((item, index) => <small key={String(item.ice_type_id ?? index)}>{String(item.ice_type_code ?? '')} {String(item.ice_type_name ?? '')}: {(Array.isArray(item.missing_ranges) ? item.missing_ranges : []).map((range) => { const value = range as Record<string, unknown>; return `${String(value.start_date)}–${String(value.end_date)}`; }).join(', ')}</small>) : null}</div></article>;
}

function EventPageState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return <div className="event-page-state">{icon}<h1>{title}</h1><p>{detail}</p>{action}</div>;
}

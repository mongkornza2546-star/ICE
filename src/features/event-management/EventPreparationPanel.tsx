import { translateUi, useLanguage } from '../../i18n';
import { useRef, useState } from 'react';
import { toBangkokDateString, shiftServiceDate } from '../../lib/serviceDate';
import { supabase } from '../../lib/supabase';
import { isAndroidApp } from '../../lib/thermalPrinter';
import { printSalesDocumentForCurrentPlatform, salesDocumentFromStored, type StoredSalesDocument } from '../../lib/salesDocumentPrint';
import type { EventManagementDetail, EventManagementGateway } from './types';

const money = (value: number) => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function EventPreparationPanel({ detail, gateway, onSaved }: {
  detail: EventManagementDetail;
  gateway: EventManagementGateway;
  onSaved: () => Promise<void>;
}) {
  useLanguage();
  const { event, participations } = detail;
  const today = toBangkokDateString();
  const latestPreparationDate = shiftServiceDate(event.start_date, -1);
  const [date, setDate] = useState(today < event.start_date ? today : latestPreparationDate);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [tankShop, setTankShop] = useState('');
  const [kind, setKind] = useState<'handoff' | 'return'>('handoff');
  const [quantity, setQuantity] = useState('1');
  const [tankDate, setTankDate] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const inFlight = useRef(false);
  const retry = useRef<{ payload: string; id: string } | null>(null);
  const movements = detail.tank_movements ?? [];
  const balance = (id: string) => movements.filter((row) => row.event_participation_id === id)
    .reduce((sum, row) => sum + (row.movement_kind === 'handoff' ? row.quantity : -row.quantity), 0);
  const active = participations.filter((row) => row.status === 'active');
  const visible = active.filter((row) => `${row.booth_number ?? ''} ${row.shop_name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const tankOptions = participations.filter((row) => kind === 'return' ? balance(row.id) > 0 : (
    event.status === 'published' && row.status === 'active'
    && tankDate >= (row.preparation_start_date ?? row.start_date) && tankDate <= row.end_date
  ));
  const run = async (action: () => Promise<string>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setSuccess('');
    try { setSuccess(await action()); await onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'บันทึกไม่สำเร็จ'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  async function printInvoice(chargeId: string) {
    if (inFlight.current) return;
    const native = isAndroidApp();
    const printWindow = native ? null : window.open('', '_blank', 'popup,width=360,height=680');
    if (!native && !printWindow) { setError('กรุณาอนุญาตป๊อปอัปเพื่อพิมพ์บิล'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (!supabase) throw new Error('ยังไม่ได้เชื่อมต่อระบบ');
      const result = await supabase.rpc('get_charge_print_document', { p_charge_id: chargeId });
      if (result.error) throw new Error(result.error.message);
      await printSalesDocumentForCurrentPlatform(salesDocumentFromStored(result.data as StoredSalesDocument), printWindow);
    } catch (cause) { printWindow?.close(); setError(cause instanceof Error ? cause.message : 'พิมพ์บิลไม่สำเร็จ'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const saveTanks = () => run(async () => {
    if (!tankOptions.some((row) => row.id === tankShop)) throw new Error('เลือกร้านที่รับหรือคืนถังได้ในวันที่ระบุ');
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('จำนวนถังต้องเป็นจำนวนเต็ม 1–10,000');
    if (kind === 'return' && count > balance(tankShop)) throw new Error('จำนวนคืนเกินถังค้าง');
    const input = { participationId: tankShop, kind, quantity: count, serviceDate: tankDate, note: note.trim() };
    const payload = JSON.stringify(input);
    if (retry.current?.payload !== payload) retry.current = { payload, id: crypto.randomUUID() };
    await gateway.recordTankMovement({ ...input, requestId: retry.current.id });
    retry.current = null;
    setTankShop(''); setNote('');
    return `${kind === 'handoff' ? 'บันทึกส่งมอบและสร้างบิลค่าเช่า' : 'บันทึกรับคืน'} ${count} ถังแล้ว`;
  });
  return <section className="event-preparation event-participations" id="event-tank-operations">
    <header><div><h3>{translateUi('เตรียมงาน / ส่งล่วงหน้า')}</h3><p>{translateUi('วันเปิดงาน ')}{event.start_date}{translateUi(' · ค่าเช่าถังเริ่มวันเปิดงาน หรือวันส่งมอบหากส่งหลังเปิดงาน')}</p></div></header>
    {error ? <div className="event-feedback event-feedback--error" role="alert">{translateUi(error)}</div> : null}
    {success ? <div className="event-feedback event-feedback--success" role="status">{translateUi(success)}</div> : null}
    {event.status !== 'cancelled' ? <details>
      <summary>{translateUi('เลือกร้านที่รับของก่อนวันเปิดงาน')}</summary>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
        if (!selected.length || !date || date >= event.start_date) throw new Error('เลือกร้านและวันที่ก่อนวันเปิดงาน');
        const result = await gateway.prepareShops(event.id, date, selected);
        setSelected([]);
        return `เปิดรับของล่วงหน้า ${result.prepared_count} ร้านแล้ว`;
      }); }}>
        <fieldset disabled={busy}>
          <label>{translateUi('วันเริ่มรับของล่วงหน้า')}<input type="date" required max={latestPreparationDate} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <p>{translateUi('ร้านที่เลือกจะปรากฏในรอบส่งตั้งแต่วันนี้ เมื่อเผยแพร่งานแล้ว เลื่อนวันให้เร็วขึ้นได้ แต่เลื่อนช้าลงไม่ได้เพื่อรักษาประวัติ')}</p>
          <label>{translateUi('ค้นหาร้านหรือบูธ')}<input value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <button type="button" className="secondary-button" onClick={() => setSelected(Array.from(new Set([...selected, ...visible.map((row) => row.id)])))}>{translateUi('เลือกทั้งหมดที่แสดง')}</button>
          <button type="button" className="secondary-button" onClick={() => setSelected([])}>{translateUi('ล้างที่เลือก')}</button>
          <div className="event-preparation-shops">{visible.map((row) => <label key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))} /><span>{translateUi('บูธ ')}{row.booth_number || '—'} · {row.shop_name}{row.preparation_start_date ? translateUi(' · รับของตั้งแต่ {0}', { 0: row.preparation_start_date }) : ''}</span></label>)}</div>
          <button className="primary-button" type="submit" disabled={!selected.length}>{translateUi('เปิดรับของล่วงหน้า ')}{selected.length}{translateUi(' ร้าน')}</button>
        </fieldset>
      </form>
      <p>{translateUi('จากนั้นเลือกวันที่ส่งจริงในเมนูบันทึกส่งน้ำแข็ง แล้วเลือกอีเวนต์นี้ ระบบใช้ราคา สต็อก และยอดขายของวันที่ส่ง')}</p>
    </details> : null}
    <details data-event-tank-details>
      <summary>{translateUi('บันทึกตั้งถัง / รับคืนถัง · ค้างทั้งหมด ')}{participations.reduce((sum, row) => sum + balance(row.id), 0)}{translateUi(' ถัง')}</summary>
      {event.status === 'draft' ? <p>{translateUi('เผยแพร่งานก่อนบันทึกส่งมอบถังจริง')}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void saveTanks(); }}><fieldset disabled={busy}>
        <div className="event-form-grid">
          <label>{translateUi('รายการ')}<select value={kind} onChange={(e) => { setKind(e.target.value as 'handoff' | 'return'); setTankShop(''); }}><option value="handoff">{translateUi('ส่งมอบถัง')}</option><option value="return">{translateUi('รับคืนถัง')}</option></select></label>
          <label>{translateUi('วันที่ส่งหรือรับคืนจริง')}<input type="date" required max={today} value={tankDate} onChange={(e) => { setTankDate(e.target.value); setTankShop(''); }} /></label>
          <label className="event-field--wide">{translateUi('ร้านค้า')}<select required value={tankShop} onChange={(e) => setTankShop(e.target.value)}><option value="">{translateUi('เลือกร้าน')}</option>{tankOptions.map((row) => <option value={row.id} key={row.id}>{translateUi('บูธ ')}{row.booth_number || '—'} · {row.shop_name}{translateUi(' · ค้าง ')}{balance(row.id)}{translateUi(' ถัง')}</option>)}</select></label>
          <label>{translateUi('จำนวนถัง')}<input type="number" required min="1" max={kind === 'return' && tankShop ? balance(tankShop) : 10000} step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
          <label>{translateUi('หมายเหตุ')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        {kind === 'handoff' ? <p>{translateUi('เริ่มค่าเช่า ')}{tankDate > event.start_date ? tankDate : event.start_date}{detail.configuration?.tank_rental_unit_price ? translateUi(' · ค่าเช่า {0} บาท/ถัง (รวม {1} บาท)', { 0: money(detail.configuration.tank_rental_unit_price), 1: money(Number(quantity || 0) * detail.configuration.tank_rental_unit_price) }) : ''}{translateUi(' · ระบบสร้างบิลค่าเช่าอัตโนมัติ')}</p> : null}
        <button className="primary-button" disabled={!tankShop || !tankOptions.length} type="submit">{busy ? translateUi('กำลังบันทึก...') : translateUi('บันทึกรายการถัง')}</button>
      </fieldset></form>
      <div className="event-import-preview"><table><thead><tr><th>{translateUi('วันที่')}</th><th>{translateUi('ร้าน / บูธ')}</th><th>{translateUi('รายการ')}</th><th>{translateUi('จำนวน')}</th><th>{translateUi('เริ่มค่าเช่า')}</th><th>{translateUi('บิลค่าเช่า')}</th><th>{translateUi('การจัดการ')}</th></tr></thead><tbody>{[...movements].reverse().map((row) => {
        const shop = participations.find((p) => p.id === row.event_participation_id);
        return <tr key={row.id}>
          <td>{row.service_date}</td>
          <td>{shop?.booth_number || '—'} · {shop?.shop_name}</td>
          <td>{row.movement_kind === 'handoff' ? translateUi('ส่งมอบ') : translateUi('รับคืน')}{row.note ? ` · ${row.note}` : ''}</td>
          <td>{row.quantity}</td>
          <td>{row.rental_start_date ?? '—'}</td>
          <td>
            {row.charge_number ? <span>{row.charge_number}{row.outstanding_amount != null ? <small style={{ display: 'block', color: Number(row.outstanding_amount) > 0 ? '#b91c1c' : '#15803d' }}>{Number(row.outstanding_amount) > 0 ? translateUi('ค้างชำระ {0} บ.', { 0: money(row.outstanding_amount) }) : translateUi('ชำระแล้ว')}</small> : null}</span> : '—'}
          </td>
          <td>
            {row.charge_id ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void printInvoice(row.charge_id!)}>{translateUi('พิมพ์บิล')}</button> : '—'}
          </td>
        </tr>;
      })}</tbody></table>{!movements.length ? <p>{translateUi('ยังไม่มีรายการส่งมอบหรือรับคืนถัง')}</p> : null}</div>
    </details>
  </section>;
}

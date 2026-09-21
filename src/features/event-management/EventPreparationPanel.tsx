import { useRef, useState } from 'react';
import { toBangkokDateString, shiftServiceDate } from '../../lib/serviceDate';
import type { EventManagementDetail, EventManagementGateway } from './types';

export function EventPreparationPanel({ detail, gateway, onSaved }: {
  detail: EventManagementDetail;
  gateway: EventManagementGateway;
  onSaved: () => Promise<void>;
}) {
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
    return `${kind === 'handoff' ? 'บันทึกส่งมอบ' : 'บันทึกรับคืน'} ${count} ถังแล้ว`;
  });
  return <section className="event-preparation event-participations">
    <header><div><h3>เตรียมงาน / ส่งล่วงหน้า</h3><p>วันเปิดงาน {event.start_date} · ค่าเช่าถังเริ่มวันเปิดงาน หรือวันส่งมอบหากส่งหลังเปิดงาน</p></div></header>
    {error ? <div className="event-feedback event-feedback--error" role="alert">{error}</div> : null}
    {success ? <div className="event-feedback event-feedback--success" role="status">{success}</div> : null}
    {event.status !== 'cancelled' ? <details>
      <summary>เลือกร้านที่รับของก่อนวันเปิดงาน</summary>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
        if (!selected.length || !date || date >= event.start_date) throw new Error('เลือกร้านและวันที่ก่อนวันเปิดงาน');
        const result = await gateway.prepareShops(event.id, date, selected);
        setSelected([]);
        return `เปิดรับของล่วงหน้า ${result.prepared_count} ร้านแล้ว`;
      }); }}>
        <fieldset disabled={busy}>
          <label>วันเริ่มรับของล่วงหน้า<input type="date" required max={latestPreparationDate} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <p>ร้านที่เลือกจะปรากฏในรอบส่งตั้งแต่วันนี้ เมื่อเผยแพร่งานแล้ว เลื่อนวันให้เร็วขึ้นได้ แต่เลื่อนช้าลงไม่ได้เพื่อรักษาประวัติ</p>
          <label>ค้นหาร้านหรือบูธ<input value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <button type="button" className="secondary-button" onClick={() => setSelected(Array.from(new Set([...selected, ...visible.map((row) => row.id)])))}>เลือกทั้งหมดที่แสดง</button>
          <button type="button" className="secondary-button" onClick={() => setSelected([])}>ล้างที่เลือก</button>
          <div className="event-preparation-shops">{visible.map((row) => <label key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))} /><span>บูธ {row.booth_number || '—'} · {row.shop_name}{row.preparation_start_date ? ` · รับของตั้งแต่ ${row.preparation_start_date}` : ''}</span></label>)}</div>
          <button className="primary-button" type="submit" disabled={!selected.length}>เปิดรับของล่วงหน้า {selected.length} ร้าน</button>
        </fieldset>
      </form>
      <p>จากนั้นเลือกวันที่ส่งจริงในเมนูบันทึกส่งน้ำแข็ง แล้วเลือกอีเวนต์นี้ ระบบใช้ราคา สต็อก และยอดขายของวันที่ส่ง</p>
    </details> : null}
    <details>
      <summary>บันทึกตั้งถัง / รับคืนถัง · ค้างทั้งหมด {participations.reduce((sum, row) => sum + balance(row.id), 0)} ถัง</summary>
      {event.status === 'draft' ? <p>เผยแพร่งานก่อนบันทึกส่งมอบถังจริง</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void saveTanks(); }}><fieldset disabled={busy}>
        <div className="event-form-grid">
          <label>รายการ<select value={kind} onChange={(e) => { setKind(e.target.value as 'handoff' | 'return'); setTankShop(''); }}><option value="handoff">ส่งมอบถัง</option><option value="return">รับคืนถัง</option></select></label>
          <label>วันที่ส่งหรือรับคืนจริง<input type="date" required max={today} value={tankDate} onChange={(e) => { setTankDate(e.target.value); setTankShop(''); }} /></label>
          <label className="event-field--wide">ร้านค้า<select required value={tankShop} onChange={(e) => setTankShop(e.target.value)}><option value="">เลือกร้าน</option>{tankOptions.map((row) => <option value={row.id} key={row.id}>บูธ {row.booth_number || '—'} · {row.shop_name} · ค้าง {balance(row.id)} ถัง</option>)}</select></label>
          <label>จำนวนถัง<input type="number" required min="1" max={kind === 'return' && tankShop ? balance(tankShop) : 10000} step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
          <label>หมายเหตุ<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        {kind === 'handoff' ? <p>เริ่มค่าเช่า {tankDate > event.start_date ? tankDate : event.start_date} · เก็บราคาเช่าตามนโยบายงานในทะเบียนถัง ยังไม่สร้างบิลค่าเช่าอัตโนมัติ</p> : null}
        <button className="primary-button" disabled={!tankShop || !tankOptions.length} type="submit">{busy ? 'กำลังบันทึก...' : 'บันทึกรายการถัง'}</button>
      </fieldset></form>
      <div className="event-import-preview"><table><thead><tr><th>วันที่</th><th>ร้าน / บูธ</th><th>รายการ</th><th>จำนวน</th><th>เริ่มค่าเช่า</th></tr></thead><tbody>{[...movements].reverse().map((row) => {
        const shop = participations.find((p) => p.id === row.event_participation_id);
        return <tr key={row.id}><td>{row.service_date}</td><td>{shop?.booth_number} · {shop?.shop_name}</td><td>{row.movement_kind === 'handoff' ? 'ส่งมอบ' : 'รับคืน'}{row.note ? ` · ${row.note}` : ''}</td><td>{row.quantity}</td><td>{row.rental_start_date ?? '—'}</td></tr>;
      })}</tbody></table>{!movements.length ? <p>ยังไม่มีรายการส่งมอบหรือรับคืนถัง</p> : null}</div>
    </details>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { isAndroidApp } from '../../../lib/thermalPrinter';
import { printSalesDocumentForCurrentPlatform, salesDocumentFromStored, type StoredSalesDocument } from '../../../lib/salesDocumentPrint';
import { env } from '../../../lib/env';
import { toBangkokDateString } from '../../../lib/serviceDate';

interface Rental {
  id: string; quantity: number; unit_price: number; total_amount: number;
  handed_out_on: string; due_on: string; note: string; outstanding_quantity: number;
  charge_id: string; charge_number: string; outstanding_amount: number;
  returns: { id: string; quantity: number; returned_on: string }[];
}
const money = (value: number) => Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ShopTankRentalPanel({ shopId, isActive, shopActive }: { shopId: string; isActive: boolean; shopActive: boolean }) {
  const today = toBangkokDateString();
  const [rows, setRows] = useState<Rental[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('100');
  const [date, setDate] = useState(today);
  const [due, setDue] = useState(today);
  const [note, setNote] = useState('');
  const [returnId, setReturnId] = useState('');
  const [returnCount, setReturnCount] = useState('1');
  const [returnDate, setReturnDate] = useState(today);
  const inFlight = useRef(false);
  const retry = useRef<{ payload: string; id: string } | null>(null);
  const selected = rows.find((row) => row.id === returnId);
  async function load() {
    if (!supabase || env.isDemoMode) { setRows([]); setLoading(false); return; }
    const result = await supabase.rpc('get_shop_tank_rentals', { p_shop_id: shopId });
    if (result.error) throw new Error(result.error.message);
    setRows(result.data ?? []);
    setLoading(false);
  }
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setLoading(true); setError('');
    if (!supabase || env.isDemoMode) { setLoading(false); return; }
    void Promise.resolve(supabase.rpc('get_shop_tank_rentals', { p_shop_id: shopId })).then(({ data, error: cause }) => {
      if (cancelled) return;
      if (cause) setError(cause.message); else setRows(data ?? []);
      setLoading(false);
    }).catch((cause: unknown) => { if (!cancelled) { setError(cause instanceof Error ? cause.message : 'โหลดรายการไม่สำเร็จ'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [shopId, isActive]);
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
  async function save(kind: 'create' | 'return') {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setSuccess('');
    try {
      if (!supabase || env.isDemoMode) throw new Error('โหมดตัวอย่างไม่บันทึกการเช่าจริง');
      const count = Number(kind === 'create' ? quantity : returnCount);
      if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('จำนวนถังต้องเป็นจำนวนเต็ม 1–10,000');
      if (kind === 'create' && (!price.trim() || !Number.isFinite(Number(price)) || Number(price) <= 0
        || !/^\d+(\.\d{1,2})?$/.test(price) || !date || date > today || !due || due < date)) throw new Error('ตรวจสอบค่าเช่าและวันส่ง–กำหนดคืน');
      if (kind === 'return' && (!selected || count > selected.outstanding_quantity || !returnDate || returnDate < selected.handed_out_on || returnDate > today)) throw new Error('ตรวจสอบจำนวนและวันที่รับคืน');
      const args = kind === 'create'
        ? { p_shop_id: shopId, p_quantity: count, p_unit_price: Number(price), p_handed_out_on: date, p_due_on: due, p_note: note.trim() }
        : { p_rental_id: returnId, p_quantity: count, p_returned_on: returnDate };
      const payload = JSON.stringify({ kind, args });
      if (retry.current?.payload !== payload) retry.current = { payload, id: crypto.randomUUID() };
      const result = await supabase.rpc(kind === 'create' ? 'create_shop_tank_rental' : 'return_shop_tank_rental', { ...args, p_request_id: retry.current.id });
      if (result.error) throw new Error(result.error.message);
      retry.current = null;
      setCreating(false); setReturnId(''); setNote(''); setQuantity('1');
      setSuccess(kind === 'create' ? 'บันทึกการเช่าและออกบิลแล้ว รับเงินได้ที่หน้ารับเงินของร้าน' : 'บันทึกรับคืนถังแล้ว');
      try { await load(); } catch { setError('บันทึกแล้ว แต่โหลดรายการล่าสุดไม่สำเร็จ กรุณากดโหลดใหม่'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'บันทึกไม่สำเร็จ'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="rented-tank-section" aria-label="เช่าถังรายครั้ง">
    <div className="panel-header"><div><p className="eyebrow">เช่าถังรายครั้ง</p><h3>ถังค้าง {rows.reduce((sum, row) => sum + Number(row.outstanding_quantity), 0)} ใบ</h3></div>
      <button className="primary-button" type="button" disabled={busy || !shopActive || loading} onClick={() => { setCreating(true); setReturnId(''); }}>เช่าถังรายครั้ง</button></div>
    <p className="muted">คิดค่าเช่าครั้งเดียวตามจำนวนถัง รับเงินรวมกับค่าน้ำแข็งได้ที่หน้ารับเงิน</p>
    {error ? <div role="alert" className="error-text">{error}<button type="button" className="ghost-button" disabled={busy} onClick={() => { setError(''); void load().catch((cause: Error) => setError(cause.message)); }}>โหลดใหม่</button></div> : null}
    {success ? <p role="status" className="success-text">{success}</p> : null}
    {!shopActive ? <p className="muted">ร้านพักใช้งานรับคืนถังได้ แต่เปิดรายการเช่าใหม่ไม่ได้</p> : null}
    {creating ? <form onSubmit={(e) => { e.preventDefault(); void save('create'); }}><fieldset disabled={busy} className="shop-rental-fields">
      <label>จำนวนถังรายครั้ง<input type="number" required min="1" max="10000" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
      <label>ค่าเช่าต่อถังต่อครั้ง (บาท)<input type="number" required min="0.01" max="999999.99" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      <label>วันที่ส่งถัง<input type="date" required max={today} value={date} onChange={(e) => { setDate(e.target.value); if (due < e.target.value) setDue(e.target.value); }} /></label>
      <label>กำหนดคืนถัง<input type="date" required min={date} value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <label>หมายเหตุการเช่า<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <strong>ค่าเช่ารวม {money(Number(quantity) * Number(price) || 0)} บาท</strong>
      <button type="submit" className="primary-button">{busy ? 'กำลังบันทึก...' : 'บันทึกเช่าและออกบิล'}</button>
      <button type="button" className="secondary-button" onClick={() => setCreating(false)}>ยกเลิก</button>
    </fieldset></form> : null}
    {selected ? <form onSubmit={(e) => { e.preventDefault(); void save('return'); }}><fieldset disabled={busy} className="shop-rental-fields"><strong>รับคืน · {selected.charge_number} · ค้าง {selected.outstanding_quantity} ใบ</strong>
      <label>จำนวนรับคืน<input type="number" required min="1" max={selected.outstanding_quantity} step="1" value={returnCount} onChange={(e) => setReturnCount(e.target.value)} /></label>
      <label>วันที่รับคืน<input type="date" required min={selected.handed_out_on} max={today} value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></label>
      <button type="submit" className="primary-button">{busy ? 'กำลังบันทึก...' : 'บันทึกรับคืน'}</button><button type="button" className="secondary-button" onClick={() => setReturnId('')}>ยกเลิก</button>
    </fieldset></form> : null}
    {loading ? <p>กำลังโหลดรายการเช่า...</p> : <div className="shop-rental-list">{rows.map((row) => <article key={row.id} className="shop-rental-card">
      <strong>{row.charge_number} · {row.outstanding_quantity > 0 ? `ค้าง ${row.outstanding_quantity} ใบ` : 'คืนครบแล้ว'}</strong>
      <span>ส่ง {row.handed_out_on} · กำหนดคืน {row.due_on}{row.outstanding_quantity > 0 && row.due_on < today ? ' · เกินกำหนดคืน' : ''}</span>
      <span>{row.quantity} ใบ × {money(row.unit_price)} = {money(row.total_amount)} บาท · ค้างชำระ {money(row.outstanding_amount)} บาท</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void printInvoice(row.charge_id)}>พิมพ์บิลค่าเช่า</button>
      {row.note ? <span>{row.note}</span> : null}
      {row.returns.map((ret) => <small key={ret.id}>รับคืน {ret.quantity} ใบ · {ret.returned_on}</small>)}
      {row.outstanding_quantity > 0 ? <button type="button" className="secondary-button" disabled={busy} onClick={() => { setReturnId(row.id); setReturnCount(String(row.outstanding_quantity)); setReturnDate(today); setCreating(false); }}>รับคืนถังรายครั้ง</button> : null}
    </article>)}{!rows.length ? <p className="muted">ยังไม่มีรายการเช่ารายครั้ง</p> : null}</div>}
  </section>;
}

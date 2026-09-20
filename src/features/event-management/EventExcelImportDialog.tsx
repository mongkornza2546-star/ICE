import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { readEventExcel, type EventExcelRow } from './eventExcelImport';
import type { EventManagementDetail, EventManagementGateway, EventNewShopsResult } from './types';

export function EventExcelImportDialog({ detail, gateway, onClose, onImported }: {
  detail: EventManagementDetail;
  gateway: EventManagementGateway;
  onClose: () => void;
  onImported: (result: EventNewShopsResult) => Promise<void>;
}) {
  const [rows, setRows] = useState<EventExcelRow[]>([]);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef('');
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    fileInput.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  const existing = new Set(detail.participations.map((row) => JSON.stringify([
    (row.event_zone ?? '').trim().toUpperCase(), (row.booth_number ?? '').trim().toUpperCase(),
  ])));
  const isExisting = (row: EventExcelRow) => existing.has(JSON.stringify([row.input.event_zone.toUpperCase(), row.input.booth_number]));
  const skipped = rows.filter(isExisting).length;
  const selectFile = async (file?: File) => {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRows([]);
    setError('');
    setFilename(file.name);
    try {
      setRows(await readEventExcel(file, detail.event));
      requestId.current = crypto.randomUUID();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'อ่านไฟล์ไม่สำเร็จ');
    } finally { inFlight.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (inFlight.current || !rows.length || rows.length === skipped) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await gateway.createEventShops(detail.event.id, requestId.current, rows.map((row) => row.input));
      await onImported(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'นำเข้าไม่สำเร็จ กรุณาลองอีกครั้ง');
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="event-modal-layer" role="dialog" aria-modal="true" aria-labelledby="event-import-title" onKeyDown={(event) => {
    if (event.key === 'Escape' && !inFlight.current) onClose();
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <button className="event-modal-backdrop" aria-label="ปิดหน้าต่าง" disabled={busy} onClick={onClose} type="button" tabIndex={-1} />
    <section className="event-modal">
      <header><div><p className="eyebrow">{detail.event.name}</p><h2 id="event-import-title">อัปโหลด Excel ร้านในงาน</h2></div><button aria-label="ปิด" disabled={busy} onClick={onClose} type="button"><X size={20} /></button></header>
      <div className="event-modal__body">
        <p>ใช้ชีตแรก โดยแถวแรกมี เลขที่บูธ และ ชื่อร้านค้า เพิ่มคอลัมน์ ถังน้ำแข็ง ได้ · สูงสุด 1,000 ร้าน / 10 MB</p>
        <label><span>เลือกไฟล์ Excel (.xlsx)</span><input ref={fileInput} type="file" accept=".xlsx" disabled={busy} onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
        <p>ใช้ช่วงวันที่ของงาน {detail.event.start_date} ถึง {detail.event.end_date} จำนวนถังจะเก็บในช่องจุดสังเกตของร้าน ยังไม่สร้างรายการเช่าหรือคิดเงิน</p>
        {error ? <div className="event-feedback event-feedback--error event-import-error" role="alert">{error}</div> : null}
        {busy ? <p role="status">กำลังดำเนินการ...</p> : null}
        {rows.length ? <>
          <p role="status">{filename} · {rows.length} ร้าน · เพิ่มใหม่ {rows.length - skipped} ร้าน · ข้ามบูธที่มีอยู่แล้ว {skipped} ร้าน</p>
          <div className="event-import-preview"><table><thead><tr><th>เลขที่บูธ</th><th>ชื่อร้านค้า</th><th>ถังน้ำแข็ง</th><th>สถานะ</th></tr></thead><tbody>{rows.map((row) => <tr key={row.rowNumber}><td>{row.input.booth_number}</td><td>{row.input.name}</td><td>{row.tankCount ?? '—'}</td><td>{isExisting(row) ? 'ข้าม (มีบูธแล้ว)' : 'เพิ่มใหม่'}</td></tr>)}</tbody></table></div>
        </> : null}
      </div>
      <footer><button className="secondary-button" disabled={busy} onClick={onClose} type="button">ยกเลิก</button><button className="primary-button" disabled={busy || !rows.length || rows.length === skipped} onClick={() => void submit()} type="button">ยืนยันนำเข้า {rows.length - skipped} ร้าน</button></footer>
    </section>
  </div>;
}

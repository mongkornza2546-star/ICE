import { useSyncExternalStore } from 'react';
import { supabase } from '../../lib/supabase';
import { translateUi } from '../../i18n';
import type { EmployeeRuntime } from './client';
import { pendingCommand } from './types';

export function OfflineStatus({ runtime }: { runtime: EmployeeRuntime }) {
  const view = useSyncExternalStore(runtime.engine.subscribe, runtime.engine.getSnapshot);
  const pending = view.commands.filter(pendingCommand);
  const ready = view.snapshot && Date.parse(view.snapshot.validUntil) > Date.now();
  return <section className="employee-offline-status" aria-label={translateUi('ข้อมูลและรายการออฟไลน์')}>
    <p role="status"><strong>{translateUi(view.preparing ? 'กำลังเตรียมข้อมูลสำหรับออฟไลน์…'
      : ready ? 'พร้อมบันทึกงานลงเครื่อง' : 'ข้อมูลออฟไลน์ยังไม่พร้อม')}</strong>
      {ready ? <span> · {translateUi('ข้อมูลล่าสุด')} {new Date(view.snapshot!.preparedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span> : null}</p>
    <p>{translateUi('รายการรอซิงก์ยังไม่ยืนยันยอดสต๊อกหรือยอดบัญชี ใบเสร็จจริงออกหลังเซิร์ฟเวอร์ยืนยัน')}</p>
    <p>{translateUi('ออฟไลน์ใช้ได้กับเบิก คืน แจ้งเสีย ส่งน้ำแข็ง และรับเงินที่เตรียมไว้ งานถัง ขายปลีก และแก้ไขรายการต้องออนไลน์และไม่มีคิวค้าง')}</p>
    {pending.some(c => c.status === 'auth_required') ? <button type="button" onClick={() => { void supabase?.auth.signOut({ scope: 'local' }); }}>{translateUi('เข้าสู่ระบบใหม่ (เก็บรายการในเครื่อง)')}</button> : null}
    {view.notice ? <p role="alert">{view.notice}</p> : null}
    <div>
      <button type="button" disabled={view.preparing || view.syncing} onClick={() => { void runtime.prepare(true); }}>{translateUi('เตรียมข้อมูลใหม่')}</button>
      <button type="button" disabled={view.syncing} onClick={() => { void runtime.engine.sync(true).then(() => runtime.prepare(true)); }}>{translateUi(view.syncing ? 'กำลังซิงก์…' : 'ซิงก์รายการ')}</button>
    </div>
    {view.commands.length ? <details open={pending.some(c => c.status === 'conflict' || c.status === 'auth_required')}>
      <summary>{translateUi('รายการรอซิงก์')} {pending.length} · {translateUi('ยืนยันแล้ว')} {view.commands.filter(c => c.status === 'applied').length}</summary>
      <ul>{view.commands.slice(-100).map(command => <li key={command.id}>
        <strong>{command.label}</strong> · {translateUi(({ pending: 'รอซิงก์', syncing: 'กำลังซิงก์', retry_wait: 'รอเชื่อมต่อ', auth_required: 'ต้องเข้าสู่ระบบใหม่', conflict: 'ต้องให้แอดมินตรวจสอบ', applied: 'เซิร์ฟเวอร์ยืนยันแล้ว', discard_approved: 'แอดมินอนุมัติยกเลิก' })[command.status])}
        <small> TMP-{command.id} · {new Date(command.recordedAt).toLocaleString('th-TH')}</small>
        {command.error ? <p role="alert">{command.error}</p> : null}
        {command.result?.receipt_number ? <p>{translateUi('เลขใบเสร็จ')} {String(command.result.receipt_number)}</p> : null}
      </li>)}</ul>
    </details> : null}
  </section>;
}

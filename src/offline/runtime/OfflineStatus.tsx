import { useSyncExternalStore } from 'react';
import { supabase } from '../../lib/supabase';
import { translateUi } from '../../i18n';
import type { EmployeeRuntime } from './client';
import { pendingCommand } from './types';

export function OfflineStatus({ runtime }: { runtime: EmployeeRuntime }) {
  const view = useSyncExternalStore(runtime.engine.subscribe, runtime.engine.getSnapshot);
  const pending = view.commands.filter(pendingCommand);
  const blocked = pending.some(c => c.status === 'blocked');
  const conflict = pending.some(c => c.status === 'conflict');
  const authRequired = pending.some(c => c.status === 'auth_required');
  const previousDay = pending.some(c => c.serviceDate !== runtime.engine.day);
  const paused = blocked || conflict || authRequired || previousDay;
  const history = view.commands.filter(c => !pendingCommand(c));
  const displayed = [...pending, ...history.slice(-100).reverse()];
  const ready = !paused && view.snapshot && Date.parse(view.snapshot.validUntil) > Date.now();
  return <section className="employee-offline-status" aria-label={translateUi('ข้อมูลและรายการออฟไลน์')}>
    <p role="status"><strong>{translateUi(blocked ? 'ระบบรับรายการไม่ได้ กรุณาให้ผู้ดูแลตรวจสอบ'
      : conflict ? 'มีรายการรอตรวจสอบ กรุณาติดต่อหัวหน้าก่อนทำรายการเพิ่ม'
      : authRequired ? 'กรุณาเข้าสู่ระบบและซิงก์รายการเดิมก่อนทำรายการเพิ่ม'
      : previousDay ? 'มีรายการค้างจากวันก่อน กรุณาซิงก์ให้เสร็จก่อนทำรายการเพิ่ม'
      : view.preparing ? 'กำลังโหลดข้อมูลงานวันนี้ กรุณารอสักครู่…'
      : ready ? 'พร้อมทำงาน แม้ไม่มีเน็ต' : 'ยังไม่พร้อมใช้งานเมื่อไม่มีเน็ต')}</strong>
      {ready ? <span> · {translateUi('ข้อมูลล่าสุด')} {new Date(view.snapshot!.preparedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span> : null}</p>
    {!paused ? <p>{translateUi(ready
      ? 'เลือกร้าน ใส่จำนวน แล้วกดส่งได้ตามปกติ แอปจะเก็บรายการไว้ในเครื่อง'
      : 'เปิดเน็ตก่อนเริ่มงานทุกวัน แล้วรอจนขึ้น “พร้อมทำงาน แม้ไม่มีเน็ต” หากโหลดไม่สำเร็จ ให้กด “โหลดข้อมูลอีกครั้ง”')}</p> : null}
    {!paused ? <p>{translateUi('เมื่อมีเน็ต เปิดแอปไว้ รายการจะส่งเข้าระบบเอง ไม่ต้องบันทึกซ้ำ ยอดสต๊อก ยอดเงิน และใบเสร็จจริงจะยืนยันหลังระบบตรวจสอบ')}</p> : null}
    <p>{translateUi('ใช้ได้กับเบิก คืน แจ้งเสีย ส่งน้ำแข็ง และรับเงินของงานที่โหลดไว้ งานถัง ขายปลีก และแก้ไขรายการ ต้องมีเน็ตและส่งรายการค้างให้ครบก่อน')}</p>
    {authRequired ? <button type="button" onClick={() => { void supabase?.auth.signOut({ scope: 'local' }); }}>{translateUi('เข้าสู่ระบบใหม่ (เก็บรายการในเครื่อง)')}</button> : null}
    {conflict ? <p role="alert">{translateUi('กดซิงก์ซ้ำจะยังทำรายการเพิ่มไม่ได้ ให้แอดมินตรวจรายการออฟไลน์ตามรายละเอียดด้านล่างก่อน แล้วกดส่งรายการค้างเข้าระบบอีกครั้ง รายการยังอยู่ในเครื่อง ไม่ต้องบันทึกซ้ำ')}</p> : null}
    {blocked ? <p role="alert">{translateUi('รายการยังอยู่ในเครื่อง ไม่ต้องบันทึกซ้ำ หลังผู้ดูแลแก้ไขแล้ว กดส่งรายการค้างเข้าระบบอีกครั้ง')}</p> : null}
    {view.notice ? <p role="alert">{view.notice}</p> : null}
    <div>
      <button type="button" disabled={view.preparing || view.syncing} onClick={() => { void runtime.prepare(true); }}>{translateUi('โหลดข้อมูลอีกครั้ง')}</button>
      <button type="button" disabled={view.syncing} onClick={() => { void runtime.engine.sync(true).then(() => runtime.prepare(true)); }}>{translateUi(view.syncing ? 'กำลังส่งเข้าระบบ…' : 'ส่งรายการค้างเข้าระบบ')}</button>
    </div>
    {view.commands.length ? <details open={paused}>
      <summary>{translateUi('ยังไม่ยืนยัน')} {pending.length} · {translateUi('ระบบยืนยันแล้ว')} {view.commands.filter(c => c.status === 'applied').length}</summary>
      <ul>{displayed.map(command => <li key={command.id}>
        <strong>{command.label}</strong> · {translateUi(({ blocked: 'ระบบรับรายการไม่ได้ กรุณาให้ผู้ดูแลตรวจสอบ', pending: 'เก็บในเครื่องแล้ว รอส่งเข้าระบบ', syncing: 'กำลังส่งเข้าระบบ…', retry_wait: 'รอส่งเข้าระบบอีกครั้ง', auth_required: 'ต้องเข้าสู่ระบบใหม่', conflict: 'ต้องให้แอดมินตรวจสอบ', applied: 'ระบบยืนยันแล้ว', discard_approved: 'แอดมินอนุมัติยกเลิก' })[command.status])}
        <small> TMP-{command.id} · {new Date(command.recordedAt).toLocaleString('th-TH')}</small>
        {command.error ? <p role="alert">{command.error}</p> : null}
        {command.result?.receipt_number ? <p>{translateUi('เลขใบเสร็จ')} {String(command.result.receipt_number)}</p> : null}
      </li>)}</ul>
    </details> : null}
  </section>;
}

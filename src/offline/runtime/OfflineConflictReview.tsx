import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { withDeadline } from './network';
import { translateUi } from '../../i18n';
interface Issue { id: string; ownerId: string; ownerName?: string; label: string; recordedAt: string; status: string; error?: string; payload: unknown }
export function OfflineConflictReview() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  async function load() {
    if (!supabase) return;
    const { data, error } = await withDeadline(signal => supabase!.rpc('get_employee_offline_commands', { p_service_date: null }).abortSignal(signal));
    if (error) { if (error.code !== 'PGRST202') setError(error.message); return; }
    setIssues((data as Issue[]).filter(i => i.status === 'conflict'));
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  async function decide(id: string, decision: 'retry' | 'approve_discard') {
    if (!supabase || !reasons[id]?.trim()) return;
    setBusy(true); setError('');
    try {
      const { error } = await withDeadline(signal => supabase!.rpc('resolve_employee_offline_command', { p_id: id, p_decision: decision, p_reason: reasons[id].trim() }).abortSignal(signal));
      if (error) throw error;
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <details className="employee-offline-status">
    <summary>{translateUi('ตรวจรายการออฟไลน์')} · {issues.length}</summary>
    <p>{translateUi('ตรวจสินค้าที่ส่งและเงินที่รับจริงก่อนตัดสินใจ การยกเลิกรายการที่ยังไม่ลงบัญชีไม่ใช่การคืนเงินหรือคืนสินค้า')}</p>
    <button type="button" disabled={busy} onClick={() => { void load().catch(e => setError(e.message)); }}>{translateUi('โหลดรายการ')}</button>
    {error ? <p role="alert">{error}</p> : null}
    {issues.length === 200 ? <p>{translateUi('แสดง 200 รายการแรก โหลดใหม่หลังตรวจสอบเพื่อดูรายการถัดไป')}</p> : null}
    {issues.map(issue => <article key={issue.id}>
      <strong>{translateUi(({ stock_transfer: 'เบิกน้ำแข็ง', stock_return: 'คืนน้ำแข็ง', stock_damage: 'น้ำแข็งละลาย/เสีย', delivery: 'บันทึกส่ง', immediate_sale: 'ส่งและรับเงิน', collection_payment: 'รับเงิน' } as Record<string, string>)[issue.label] ?? issue.label)}</strong><p>{issue.recordedAt} · {issue.ownerName ?? issue.ownerId} · {issue.id}</p><p>{issue.error}</p>
      <details><summary>{translateUi('ข้อมูลรายการ')}</summary><pre>{JSON.stringify(issue.payload, null, 2)}</pre></details>
      <label>{translateUi('เหตุผลและผลตรวจสอบ')}<input value={reasons[issue.id] ?? ''} onChange={e => setReasons({ ...reasons, [issue.id]: e.target.value })} /></label>
      <button disabled={busy || !reasons[issue.id]?.trim()} type="button" onClick={() => void decide(issue.id, 'retry')}>{translateUi('ให้ลองซิงก์รายการเดิม')}</button>
      <button disabled={busy || !reasons[issue.id]?.trim()} type="button" onClick={() => void decide(issue.id, 'approve_discard')}>{translateUi('อนุมัติยกเลิกรายการที่ยังไม่ลงบัญชี')}</button>
    </article>)}
  </details>;
}

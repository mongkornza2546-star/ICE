import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingPage } from '../src/features/accounting/AccountingPage';
import type { AccountingTransaction, AccountingReviewItem } from '../src/features/accounting/types';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const summary = { rows: [], total_count: 0, totals: { sales_amount: 0, paid_amount: 0, outstanding_amount: 0, overdue_amount: 0, outstanding_shop_count: 0, cumulative_outstanding_amount: 0, cumulative_overdue_amount: 0, cumulative_outstanding_shop_count: 0, cash_received_in_period: 0 }, facets: { shops: [], buildings: [], zones: [] } };
const issue: AccountingReviewItem = { issue_id: 'daily-close-1', issue_type: 'CASH_VARIANCE', severity: 'critical', service_date: today, occurred_at: `${today}T18:00:00+07:00`, document_number: null, shop_name: 'พนักงานตัวอย่าง', title: 'เงินสดต่างยอด', description: 'ควรส่ง 100 บาท นับจริง 90 บาท', source_id: 'issue-1', delivery_event_id: null, payment_id: null };
const receipt: AccountingTransaction = { occurred_at: `${today}T17:00:00+07:00`, service_date: today, type: 'REC', group_id: 'payment-1', source_id: 'payment-1', source_table: 'payments', delivery_event_id: null, payment_id: 'payment-1', document_number: 'REC-001', reference_number: 'INV-001', shop_id: 'shop-1', shop_code: 'S001', shop_name: 'ร้านทดสอบ', holder_name: 'รถ 1', employee_id: null, employee_name: 'ผู้บันทึก', ice_type_id: null, ice_type_name: null, unit: null, quantity_in: 0, quantity_out: 0, sales_amount: 0, cash_in: 900, cash_out: 0, receivable_delta: -900, status: 'active', note: null, issue_code: null, issue_label: null, can_correct: false, details: {} };
const ok = (data: unknown) => ({ data, error: null });
const transactions = { rows: [receipt], total_count: 1, facets: { shops: [], employees: [], types: [], ice_types: [] } };
function baseRpc(name: string, args: Record<string, any>) {
  if (name === 'get_accounting_shop_summary') return ok(summary);
  if (name === 'get_accounting_shop_daily_matrix') return ok({ rows: [], ice_types: [] });
  if (name === 'get_accounting_review_queue') return ok({ rows: args.p_limit === 1 ? [] : [issue], total_count: args.p_limit === 1 ? 74 : args.p_filters.document ? 1 : 2 });
  if (name === 'get_accounting_transactions') return ok(transactions);
  if (name === 'get_payment_correction_targets') return ok([]);
  if (name === 'get_payment_receipt_snapshot') return ok({ document_type: 'REC', document_number: 'REC-001', recorded_at: `${today}T17:00:00+07:00`, payment_method: 'cash', recorded_by_name: 'ผู้รับเงิน', allocated_amount: 900, received_amount: 1000, change_amount: 100, charges: [{ charge_number: 'INV-001', received_amount: 900, items: [] }] });
  throw new Error(`Unmocked RPC ${name}`);
}
beforeEach(() => { rpc.mockReset(); rpc.mockImplementation(async (name, args) => baseRpc(name, args)); });

describe('accounting workspace interactions', () => {
  it('isolates document and review searches and keeps the badge scoped to the full period', async () => {
    const user = userEvent.setup();
    render(<AccountingPage />);
    await screen.findByText('ยอดขายรายร้านในช่วง');
    await user.click(screen.getByRole('button', { name: 'เอกสารและการเงิน', exact: true }));
    await user.type(screen.getByRole('textbox', { name: 'ค้นเอกสาร' }), 'REC-001');
    await user.click(screen.getByRole('button', { name: /รายการต้องตรวจสอบ.*74/ }));
    expect((screen.getByRole('textbox', { name: 'ค้นเอกสาร' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('checkbox', { name: /เฉพาะมีประเด็น/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'ค้นเอกสาร' }), 'พนักงาน');
    await screen.findByText('ทั้งหมด 1 รายการ');
    expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ.*74/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'เอกสารและการเงิน', exact: true }));
    expect((screen.getByRole('textbox', { name: 'ค้นเอกสาร' }) as HTMLInputElement).value).toBe('REC-001');
  });

  it('requires a resolution note, retains a failed submission, and refreshes only after success', async () => {
    let attempts = 0;
    rpc.mockImplementation(async (name, args) => name === 'resolve_daily_close_reconciliation_issue' ? ++attempts === 1 ? { data: null, error: { message: 'บันทึกไม่สำเร็จ' } } : ok(null) : baseRpc(name, args));
    const user = userEvent.setup();
    render(<AccountingPage />);
    await user.click(await screen.findByRole('button', { name: /รายการต้องตรวจสอบ.*74/ }));
    await user.click(await screen.findByRole('button', { name: 'ปิดประเด็น', exact: true }));
    const dialog = screen.getByRole('dialog', { name: 'ปิดประเด็นตรวจสอบ' });
    const save = within(dialog).getByRole('button', { name: 'บันทึกและปิดประเด็น' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByRole('textbox', { name: /ผลตรวจสอบ/ }), ' ตรวจนับและบันทึกส่วนต่างแล้ว ');
    await user.type(within(dialog).getByRole('textbox', { name: /เลขอ้างอิง/ }), ' DOC-123 ');
    await user.click(save);
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'บันทึกไม่สำเร็จ');
    expect((within(dialog).getByRole('textbox', { name: /ผลตรวจสอบ/ }) as HTMLTextAreaElement).value).toContain('ตรวจนับ');
    await user.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpc).toHaveBeenCalledWith('resolve_daily_close_reconciliation_issue', { p_issue_id: 'issue-1', p_resolution_note: 'ตรวจนับและบันทึกส่วนต่างแล้ว', p_external_reference: 'DOC-123' });
    expect(document.body.style.overflow).toBe('');
  });

  it('renders a readable receipt and keeps keyboard focus inside its dialog', async () => {
    const user = userEvent.setup();
    render(<AccountingPage />);
    await user.click(screen.getByRole('button', { name: 'เอกสารและการเงิน', exact: true }));
    const opener = await screen.findByRole('button', { name: 'REC-001', exact: true });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'รายละเอียด REC-001' });
    expect(await within(dialog).findByText('สำเนาใบเสร็จเดิม')).toBeTruthy();
    expect(within(dialog).getByText('เงินสด')).toBeTruthy();
    expect(within(dialog).getAllByText('INV-001').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('฿1,000.00')).toBeTruthy();
    expect(dialog.querySelector('pre')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /ยกเลิกใบส่ง/ })).toBeNull();
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('retries receipt failures without losing the selected transaction', async () => {
    let attempts = 0;
    rpc.mockImplementation(async (name, args) => name === 'get_payment_receipt_snapshot' && ++attempts === 1 ? { data: null, error: { message: 'สำเนายังโหลดไม่ได้' } } : baseRpc(name, args));
    const user = userEvent.setup();
    render(<AccountingPage />);
    await user.click(screen.getByRole('button', { name: 'เอกสารและการเงิน', exact: true }));
    await user.click(await screen.findByRole('button', { name: 'REC-001', exact: true }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('สำเนายังโหลดไม่ได้'));
    await user.click(within(dialog).getByRole('button', { name: 'ลองโหลดรายละเอียดอีกครั้ง' }));
    expect(await within(dialog).findByText('สำเนาใบเสร็จเดิม')).toBeTruthy();
  });

  it('opens the document referenced by a review item with the report dates intact', async () => {
    rpc.mockImplementation(async (name, args) => name === 'get_accounting_review_queue' ? ok({ rows: [{ ...issue, issue_id: 'unpaid-1', document_number: 'INV-001', delivery_event_id: 'event-1' }], total_count: 1 }) : baseRpc(name, args));
    const user = userEvent.setup();
    render(<AccountingPage />);
    const from = (screen.getByLabelText('จาก') as HTMLInputElement).value;
    await user.click(await screen.findByRole('button', { name: /รายการต้องตรวจสอบ.*1/ }));
    await user.click(await screen.findByRole('button', { name: 'ดูเอกสารต้นทาง' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_accounting_transactions', expect.objectContaining({ p_from_date: from, p_to_date: today, p_filters: expect.objectContaining({ document: 'INV-001' }) })));
    expect(screen.getByRole('button', { name: 'เอกสารและการเงิน', exact: true }).getAttribute('aria-current')).toBe('page');
  });

  it('uses the report end date for reconciliation and exposes holder counts without turning missing counts into zero', async () => {
    rpc.mockImplementation(async (name, args) => name === 'get_accounting_reconciliation' ? ok({ service_date: args.p_service_date, financial: { effective_sales: 100, allocated_to_sales: 70, outstanding_collectible: 30, outstanding_credit: 0, cash_received: 50, cash_refunded: 10, net_cash: 40, pending_refunds: 0 }, aggregate: [], holders: [{ location_id: 'truck-1', location_name: 'รถส่ง 1', employee_name: 'พนักงาน', items: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', factory_in: 10, sold: 5, damaged: 0, returned_to_factory: 0, expected: 5, actual: null, variance: null, count_status: 'incomplete' }] }] }) : baseRpc(name, args));
    const user = userEvent.setup();
    render(<AccountingPage />);
    const previousDay = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: previousDay } });
    await user.click(screen.getByRole('button', { name: 'สรุปเทียบยอด' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_accounting_reconciliation', { p_service_date: previousDay }));
    await user.click(await screen.findByText('สต๊อกแยกจุดถือครอง'));
    expect(screen.getByText('รถส่ง 1 · พนักงาน')).toBeTruthy();
    expect(screen.getByText('ยังนับไม่ครบ')).toBeTruthy();
    expect(screen.getAllByRole('cell', { name: '—' }).length).toBe(2);
  });

  it('restores the report period after opening an older source and retains the shop view', async () => {
    const oldDay = '2025-01-01';
    rpc.mockImplementation(async (name, args) => name === 'get_accounting_review_queue'
      ? ok({ rows: [{ ...issue, service_date: oldDay, document_number: 'INV-OLD' }], total_count: 1 })
      : baseRpc(name, args));
    const user = userEvent.setup();
    render(<AccountingPage />);
    const originalFrom = (screen.getByLabelText('จาก') as HTMLInputElement).value;
    await user.click(await screen.findByRole('button', { name: 'ตารางรายวัน', exact: true }));
    await user.click(await screen.findByRole('button', { name: /รายการต้องตรวจสอบ.*1/ }));
    await user.click(await screen.findByRole('button', { name: 'ดูเอกสารต้นทาง' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_accounting_transactions', expect.objectContaining({ p_from_date: oldDay, p_to_date: oldDay, p_filters: expect.objectContaining({ document: 'INV-OLD' }) })));
    await user.click(screen.getByRole('button', { name: 'กลับไปรายการต้องตรวจสอบ' }));
    expect((screen.getByLabelText('จาก') as HTMLInputElement).value).toBe(originalFrom);
    expect((screen.getByLabelText('ถึง') as HTMLInputElement).value).toBe(today);
    await user.click(screen.getByRole('button', { name: 'สรุปรายร้าน', exact: true }));
    expect((await screen.findByRole('button', { name: 'ตารางรายวัน', exact: true })).getAttribute('aria-pressed')).toBe('true');
  });
});

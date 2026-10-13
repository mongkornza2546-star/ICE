import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExecutiveFollowUps } from '../src/features/reports/ExecutiveFollowUps';
import type { ExecutiveReport, ReportRow } from '../src/features/reports/types';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));

const report: ExecutiveReport = {
  from: '2026-09-01', to: '2026-09-07', asOf: '2026-10-12T18:00:00Z',
  previousFrom: '2026-08-25', previousTo: '2026-08-31',
  sales: 600, receipts: 450, refunds: 0, netReceipts: 450,
  previousSales: 700, previousNetReceipts: 600,
  outstanding: 1000, overdue: 638, debtors: 8, deliveryCount: 0,
  trend: [], areas: [], shops: [], products: [],
};

const shop = (id: string, amount: number, dueDate: string | null = '2026-10-12'): ReportRow => ({
  id, shopId: id, label: `ร้าน ${id}`, amount, day: '2026-09-01', dueDate,
});
const response = (rows: ReportRow[]) => ({ data: { total: rows.length, rows }, error: null });
const callbacks = () => ({ onOpenAll: vi.fn(), onOpenShop: vi.fn() });

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue(response([shop('หนึ่ง', 638)]));
});

it('loads the top overdue shops for current debt with the report dates and a five-row limit', async () => {
  render(<ExecutiveFollowUps report={report} isActive {...callbacks()} />);
  expect(screen.getByRole('status').textContent).toContain('กำลังโหลดร้านที่ต้องติดตาม');
  await screen.findByRole('button', { name: /ร้าน หนึ่ง/ });
  expect(rpc).toHaveBeenCalledWith('get_executive_report_details', {
    p_from: '2026-09-01', p_to: '2026-09-07', p_metric: 'overdue', p_limit: 5, p_offset: 0,
    p_bucket: null, p_area_kind: null, p_area_id: null, p_shop_id: null,
  });
  expect(screen.getByText('63.8% ของหนี้ค้างปัจจุบัน')).not.toBeNull();
  expect(screen.getByText(/ยอดหนี้ ณ 13 ต.ค. 2569 · ไม่ขึ้นกับช่วงวันที่เลือก/)).not.toBeNull();
  expect(screen.getByText('เกินกำหนดนานสุด 1 วัน')).not.toBeNull();
});

it('sorts and limits demo shops without mutating input or requesting the backend, and passes focus triggers', async () => {
  const demoRows = [shop('A', 10), shop('B', 50), shop('C', 30), shop('D', 70), shop('E', 20), shop('F', 60)];
  const handlers = callbacks();
  render(<ExecutiveFollowUps report={report} isActive demoRows={demoRows} {...handlers} />);
  const buttons = within(await screen.findByRole('list', { name: 'ร้านที่ต้องติดตาม' })).getAllByRole('button');
  expect(buttons.map((button) => button.textContent?.match(/ร้าน [A-F]/)?.[0])).toEqual([
    'ร้าน D', 'ร้าน F', 'ร้าน B', 'ร้าน C', 'ร้าน E',
  ]);
  expect(demoRows.map((row) => row.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  expect(rpc).not.toHaveBeenCalled();
  fireEvent.click(buttons[0]);
  expect(handlers.onOpenShop).toHaveBeenCalledWith(demoRows[3], buttons[0]);
  const all = screen.getByRole('button', { name: 'ดูร้านเกินกำหนดทั้งหมด ›' });
  fireEvent.click(all);
  expect(handlers.onOpenAll).toHaveBeenCalledWith(all);
});

it('does not fetch when debt is zero and avoids an undefined share of zero outstanding debt', () => {
  render(<ExecutiveFollowUps report={{ ...report, overdue: 0, outstanding: 0 }} isActive {...callbacks()} />);
  expect(screen.getByText('ไม่มีหนี้เกินกำหนดที่ต้องติดตาม')).not.toBeNull();
  expect(screen.queryByText(/% ของหนี้ค้างปัจจุบัน/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'ดูร้านเกินกำหนดทั้งหมด ›' })).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it('uses the report as-of day for older due dates and states when the due date is missing', async () => {
  render(<ExecutiveFollowUps report={report} isActive demoRows={[
    shop('เก่า', 500, '2026-09-30'), shop('ไม่ทราบ', 138, null),
  ]} {...callbacks()} />);
  expect(await screen.findByText('เกินกำหนดนานสุด 13 วัน')).not.toBeNull();
  expect(screen.getByText('ไม่ระบุวันครบกำหนด')).not.toBeNull();
});

it('keeps the nonzero summary visible on a failed request and retries', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'เครือข่ายขัดข้อง' } });
  render(<ExecutiveFollowUps report={report} isActive {...callbacks()} />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('เครือข่ายขัดข้อง');
  expect(screen.getByText('฿638')).not.toBeNull();
  expect(screen.queryByText('ไม่มีหนี้เกินกำหนดที่ต้องติดตาม')).toBeNull();
  fireEvent.click(within(alert).getByRole('button', { name: 'ลองใหม่' }));
  await screen.findByRole('button', { name: /ร้าน หนึ่ง/ });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['rejected', 'missing data'])('shows an explicit error for %s responses', async (failure) => {
  if (failure === 'rejected') rpc.mockRejectedValueOnce(new Error('เครือข่ายขัดข้อง'));
  else rpc.mockResolvedValueOnce({ data: null, error: null });
  render(<ExecutiveFollowUps report={report} isActive {...callbacks()} />);
  expect((await screen.findByRole('alert')).textContent).toContain('โหลดร้านที่ต้องติดตามไม่สำเร็จ');
  expect(screen.queryByText('ไม่มีหนี้เกินกำหนดที่ต้องติดตาม')).toBeNull();
});

it('does not describe a missing shop list as zero overdue debt', async () => {
  render(<ExecutiveFollowUps report={report} isActive demoRows={[]} {...callbacks()} />);
  expect(await screen.findByText('ไม่พบรายการร้านค้า กรุณารีเฟรชรายงาน')).not.toBeNull();
  expect(screen.queryByText('ไม่มีหนี้เกินกำหนดที่ต้องติดตาม')).toBeNull();
  expect(screen.getByText('฿638')).not.toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it('clears prior rows during report refresh and ignores late responses from older reports', async () => {
  type Response = ReturnType<typeof response>;
  let finishOld!: (value: Response) => void;
  let finishNew!: (value: Response) => void;
  const handlers = callbacks();
  const view = render(<ExecutiveFollowUps report={report} isActive {...handlers} />);
  await screen.findByRole('button', { name: /ร้าน หนึ่ง/ });
  rpc.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }));
  view.rerender(<ExecutiveFollowUps report={{ ...report, asOf: '2026-10-13T03:00:00Z' }} isActive {...handlers} />);
  expect(screen.queryByRole('button', { name: /ร้าน หนึ่ง/ })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('กำลังโหลด');
  rpc.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishNew = resolve; }));
  view.rerender(<ExecutiveFollowUps report={{ ...report, asOf: '2026-10-13T04:00:00Z' }} isActive {...handlers} />);
  await act(async () => { finishNew(response([shop('ล่าสุด', 600)])); });
  expect(screen.getByRole('button', { name: /ร้าน ล่าสุด/ })).not.toBeNull();
  await act(async () => { finishOld(response([shop('ล้าสมัย', 500)])); });
  expect(screen.queryByRole('button', { name: /ร้าน ล้าสมัย/ })).toBeNull();
  expect(screen.getByRole('button', { name: /ร้าน ล่าสุด/ })).not.toBeNull();
});

it('waits until active, clears a pending request when hidden, and fetches again when reopened', async () => {
  let finishHidden!: (value: ReturnType<typeof response>) => void;
  rpc.mockImplementationOnce(() => new Promise<ReturnType<typeof response>>((resolve) => { finishHidden = resolve; }));
  const handlers = callbacks();
  const view = render(<ExecutiveFollowUps report={report} isActive={false} {...handlers} />);
  expect(rpc).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'ต้องติดตาม' })).toBeNull();
  view.rerender(<ExecutiveFollowUps report={report} isActive {...handlers} />);
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  view.rerender(<ExecutiveFollowUps report={report} isActive={false} {...handlers} />);
  await act(async () => { finishHidden(response([shop('ล้าสมัย', 500)])); });
  view.rerender(<ExecutiveFollowUps report={report} isActive {...handlers} />);
  await screen.findByRole('button', { name: /ร้าน หนึ่ง/ });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: /ร้าน ล้าสมัย/ })).toBeNull();
});

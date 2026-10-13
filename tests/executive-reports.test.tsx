import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExecutiveReportsPage } from '../src/features/reports/ExecutiveReportsPage';
import { LocalDemoApp } from '../src/LocalDemoApp';
import { formatReportDate, presetDates } from '../src/features/reports/reportDates';

const { rpc, writeXlsxFile } = vi.hoisted(() => ({ rpc: vi.fn(), writeXlsxFile: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('write-excel-file', () => ({ default: writeXlsxFile }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T02:23:00Z'));
  const { from, to } = presetDates('month');
  rpc.mockReset();
  writeXlsxFile.mockReset();
  rpc.mockImplementation((name: string, args: { p_metric?: string; p_bucket?: string; p_from?: string; p_to?: string }) => Promise.resolve({
    error: null,
    data: name === 'get_executive_report_invoice' ? {
      number: 'C-001', shop: 'ร้านหนึ่ง', serviceDate: from, area: 'อาคาร A',
      dueDate: from, total: 500, paid: 200,
      items: [{ name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity: 10 }],
      payments: [{ date: new Date().toISOString(), method: 'cash', amount: 200 }],
    } : name === 'get_executive_report' ? {
      from: args.p_from ?? from, to: args.p_to ?? to, asOf: new Date().toISOString(),
      sales: 500, receipts: 300, refunds: 20, netReceipts: 280,
      previousSales: 250, previousNetReceipts: 140,
      outstanding: 180, overdue: 80, debtors: 2, deliveryCount: 4,
      trend: [{ date: from, sales: 500, receipts: 300, refunds: 20 }],
      areas: [{ kind: 'building', id: 'building-1', name: 'อาคาร A', sales: 500 }],
      shops: [{ id: 'shop-1', name: 'ร้านหนึ่ง', sales: 500 }],
      products: [{ id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', delivered: 10, damaged: 1 }],
      volumeAreas: [
        { kind: 'building', id: 'building-1', name: 'อาคาร A', products: [
          { id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', delivered: 6.5, damaged: 0.5 },
        ] },
        { kind: 'building', id: 'building-2', name: 'อาคาร B', products: [
          { id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', delivered: 2.5, damaged: 0.5 },
        ] },
        { kind: 'casual', id: null, name: 'ขายหน้ารถ', products: [
          { id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', delivered: 1, damaged: 0 },
        ] },
      ],
    } : {
      total: 1,
      rows: [{ id: 'item-1', day: args.p_bucket ?? from, label: 'ร้านหนึ่ง',
        amount: args.p_metric === 'receipts' ? 300 : args.p_metric === 'refunds' ? 20
          : args.p_metric === 'debt' ? 180 : 500,
        area: 'อาคาร A', shopId: 'shop-1' }],
    },
  }));
});

afterEach(() => vi.useRealTimers());

it('shows a simple summary and preserves the full selected dates for totals and drilldowns', async () => {
  render(<ExecutiveReportsPage isActive />);
  fireEvent.click(screen.getByRole('button', { name: '7 วัน' }));
  const sales = await screen.findByRole('button', { name: /ยอดขายสุทธิช่วงนี้/ });
  expect(sales.querySelector('strong')?.textContent).toBe('฿500');
  expect(screen.getByRole('button', { name: /เงินรับสุทธิช่วงนี้/ }).querySelector('strong')?.textContent).toBe('฿280');
  expect(sales.textContent).not.toContain('%');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByText(/เปรียบเทียบ|วันที่สิ้นสุดแล้ว|ช่วงก่อน/)).toBeNull();
  expect(screen.queryByRole('region', { name: 'ต้องติดตาม' })).toBeNull();
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-07', p_to: '2026-10-13' });
  expect(rpc.mock.calls.every(([name]) => name === 'get_executive_report')).toBe(true);
  fireEvent.click(sales);
  await screen.findByRole('dialog');
  expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
    p_from: '2026-10-07', p_to: '2026-10-13', p_metric: 'sales',
  }));
});

it('uses the selected dates for today and historical summaries without comparison settings', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  rpc.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'วันนี้' }));
  const todaySales = await screen.findByRole('button', { name: /ยอดขายสุทธิช่วงนี้/ });
  expect(todaySales.querySelector('strong')?.textContent).toBe('฿500');
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-13', p_to: '2026-10-13' });
  fireEvent.change(screen.getByLabelText('จาก'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: '2026-10-06' } });
  const historical = await screen.findByRole('button', { name: /ยอดขายสุทธิช่วงนี้/ });
  expect(historical.querySelector('strong')?.textContent).toBe('฿500');
  expect(rpc).toHaveBeenCalledWith('get_executive_report', { p_from: '2026-10-01', p_to: '2026-10-06' });
  expect(rpc.mock.calls.every(([name]) => name === 'get_executive_report')).toBe(true);
  expect(screen.queryByText(/เปรียบเทียบ|วันที่สิ้นสุดแล้ว|ช่วงก่อน/)).toBeNull();
});

it('exports full selected-period totals without comparison configuration or requests', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByRole('button', { name: /ยอดขายสุทธิช่วงนี้/ });
  const exportButton = screen.getByRole('button', { name: /ส่งออก Excel/ });
  expect(exportButton.hasAttribute('disabled')).toBe(false);
  fireEvent.click(exportButton);
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  const rows = writeXlsxFile.mock.calls[0][0][0].map((row: Array<{ value: unknown }>) => row.map((cell) => cell.value));
  expect(rows).toContainEqual(['รายงานผู้บริหาร', '2026-10-01 ถึง 2026-10-13']);
  expect(rows).toContainEqual(['ยอดขายสุทธิช่วงนี้', 500]);
  expect(rows).toContainEqual(['เงินรับสุทธิช่วงนี้', 280]);
  expect(rows.flat().some((value: unknown) => typeof value === 'string' && /เปรียบเทียบ|ช่วงก่อน/.test(value))).toBe(false);
  expect(rpc.mock.calls.every(([name]) => name === 'get_executive_report' || name === 'get_executive_report_details')).toBe(true);
  const detailRequests = rpc.mock.calls.filter(([name]) => name === 'get_executive_report_details');
  expect(detailRequests).toHaveLength(4);
  for (const [, args] of detailRequests) expect(args).toMatchObject({ p_from: '2026-10-01', p_to: '2026-10-13' });
});

it('opens overdue shop invoices from finance and restores focus even after the report refreshes', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(screen.getByRole('button', { name: 'เงินรับและลูกหนี้' }));
  const followUps = await screen.findByRole('region', { name: 'ต้องติดตาม' });
  const originalButton = await within(followUps).findByRole('button', { name: /ร้านหนึ่ง/ });
  fireEvent.click(originalButton);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('ทั้งหมด 1 รายการ');
  expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
    p_metric: 'overdue', p_shop_id: 'shop-1', p_limit: 50,
  }));
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(originalButton.isConnected).toBe(false));
  const refreshedButton = await within(followUps).findByRole('button', { name: /ร้านหนึ่ง/ });
  fireEvent.click(within(dialog).getByRole('button', { name: 'ปิดรายละเอียด' }));
  await waitFor(() => expect(document.activeElement).toBe(refreshedButton));
});

it('shows business totals and drills into the selected building', async () => {
  render(<ExecutiveReportsPage isActive />);
  expect(await screen.findByText('อาคาร A')).not.toBeNull();
  expect(screen.getByText('หนี้ค้างปัจจุบัน')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณส่ง' }));
  expect(within(screen.getByRole('table', { name: 'ปริมาณงานและน้ำแข็ง' })).getByText('น้ำแข็งหลอด')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ภาพรวม' }));
  fireEvent.click(within(screen.getByLabelText('ยอดขายตามพื้นที่')).getByRole('button', { name: /อาคาร A/ }));
  await screen.findByRole('dialog', { name: 'รายละเอียดยอดขายสุทธิ' });
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
    p_metric: 'sales', p_area_kind: 'building', p_area_id: 'building-1',
  })));
  expect(screen.getByText('ทั้งหมด 1 รายการ')).not.toBeNull();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /ร้านหนึ่ง/ }));
  expect(await screen.findByText('C-001')).not.toBeNull();
  expect(screen.getByText('คงค้าง')).not.toBeNull();
});

it('switches report sections, opens a shop, and restores focus when details close', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'หมวดรายงาน' })).getByRole('button', { name: 'ยอดขาย' }));
  expect(screen.getByRole('table', { name: 'ตารางยอดขายตามพื้นที่' })).not.toBeNull();
  expect(screen.getByText('100%')).not.toBeNull();
  const shop = within(screen.getByRole('table', { name: 'ร้านค้ายอดขายสูงสุด' }))
    .getByRole('button', { name: /ร้านหนึ่ง/ });
  fireEvent.click(shop);
  await screen.findByRole('dialog', { name: 'รายละเอียดยอดขายสุทธิ' });
  expect(screen.getByRole('heading', { name: 'ร้านหนึ่ง' })).not.toBeNull();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ปิดรายละเอียด' }));
  await waitFor(() => expect(document.activeElement).toBe(shop));
  expect(within(screen.getByRole('navigation', { name: 'หมวดรายงาน' })).getByRole('button', { name: 'ยอดขาย' }).getAttribute('aria-current')).toBe('page');
});

it('shows the receipt equation and pages through detail rows', async () => {
  const original = rpc.getMockImplementation();
  rpc.mockImplementation((name: string, args: { p_metric?: string; p_offset?: number }) => {
    if (name === 'get_executive_report_details' && args.p_metric === 'receipts') return Promise.resolve({
      error: null, data: { total: 51, rows: Array.from({ length: args.p_offset ? 1 : 50 }, (_, index) => ({
        id: `receipt-${(args.p_offset ?? 0) + index}`, day: presetDates('month').from,
        label: `ร้าน ${(args.p_offset ?? 0) + index + 1}`, amount: 1, area: 'อาคาร A', method: 'cash',
      })) },
    });
    return original?.(name, args);
  });
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(screen.getByRole('button', { name: 'เงินรับและลูกหนี้' }));
  expect(screen.getByText('เงินรับจริง')).not.toBeNull();
  expect(screen.getByText('เงินคืนจริง')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /ดูรายการรับเงิน/ }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('ทั้งหมด 51 รายการ');
  expect(within(dialog).getAllByText(/เงินสด/).length).toBe(50);
  fireEvent.click(within(dialog).getByRole('button', { name: 'ถัดไป' }));
  await within(dialog).findByText('หน้า 2 / 2');
  expect(within(dialog).getByText('ร้าน 51')).not.toBeNull();
});

it('handles zero sales and a negative net receipt without misleading comparisons', async () => {
  const original = rpc.getMockImplementation();
  rpc.mockImplementation(async (name: string, args: unknown) => {
    const result = await original?.(name, args);
    if (name !== 'get_executive_report') return result;
    return { ...result, data: { ...result.data,
      sales: 0, previousSales: 0, receipts: 5, refunds: 10,
      netReceipts: -5, previousNetReceipts: 0,
      areas: [{ ...result.data.areas[0], sales: 0 }],
      trend: [{ ...result.data.trend[0], receipts: 5, refunds: 10 }],
    } };
  });
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  expect(screen.getByRole('button', { name: /ยอดขายสุทธิช่วงนี้/ }).querySelector('strong')?.textContent).toBe('฿0');
  expect(screen.getByRole('button', { name: /เงินรับสุทธิช่วงนี้/ }).querySelector('strong')?.textContent).toBe('-฿5');
  expect(screen.queryByText(/ไม่มีฐานเปรียบเทียบ/)).toBeNull();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'หมวดรายงาน' })).getByRole('button', { name: 'ยอดขาย' }));
  expect(within(screen.getByRole('table', { name: 'ตารางยอดขายตามพื้นที่' })).getByText('—')).not.toBeNull();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'หมวดรายงาน' })).getByRole('button', { name: 'ภาพรวม' }));
  fireEvent.click(within(screen.getByLabelText('เลือกตัวเลขในกราฟ')).getByRole('button', { name: 'เงินรับสุทธิ' }));
  expect(within(screen.getByLabelText('กราฟเงินรับสุทธิ')).getByRole('button', { name: /-฿5/ })).not.toBeNull();
});

it('does not request an invalid custom date range', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  rpc.mockClear();
  const dates = screen.getAllByLabelText(/จาก|ถึง/);
  fireEvent.change(dates[0], { target: { value: '2025-01-01' } });
  await screen.findByText('เลือกช่วงได้สูงสุด 366 วัน');
  expect(rpc).not.toHaveBeenCalled();
});

it('drills from current debtors to their invoices', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(screen.getByRole('button', { name: /หนี้ค้างปัจจุบัน/ }));
  await screen.findByText('ทั้งหมด 1 รายการ');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /ร้านหนึ่ง/ }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
    p_metric: 'debt', p_shop_id: 'shop-1',
  })));
  expect(screen.getByRole('heading', { name: 'ร้านหนึ่ง' })).not.toBeNull();
});

it('exports a reconciled workbook with summary, trend, areas, and detail sheets', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(screen.getByRole('button', { name: /ส่งออก Excel/ }));
  await waitFor(() => expect(writeXlsxFile).toHaveBeenCalledTimes(1));
  expect(writeXlsxFile.mock.calls[0][1].sheets).toEqual(['สรุป', 'แนวโน้ม', 'พื้นที่', 'รายการ', 'ปริมาณรวม', 'ปริมาณแยกตึก']);
  const rows = (index: number) => writeXlsxFile.mock.calls[0][0][index].map((row: Array<{ value: unknown }>) => row.map((cell) => cell.value));
  expect(rows(4)).toContainEqual(['น้ำแข็งหลอด', 'ถุง', 10, 1]);
  expect(rows(5)).toContainEqual(['ตึก', 'อาคาร A', 'น้ำแข็งหลอด', 'ถุง', 6.5, 0.5]);
  expect(rows(5)).toContainEqual(['ตึก', 'อาคาร B', 'น้ำแข็งหลอด', 'ถุง', 2.5, 0.5]);
  expect(rows(5)).toContainEqual(['ขายหน้ารถ', 'ขายหน้ารถ', 'น้ำแข็งหลอด', 'ถุง', 1, 0]);
});

it('opens the report from the local demo entry point without a backend request', async () => {
  window.history.replaceState(null, '', '/?screen=executive-report');
  try {
    render(<LocalDemoApp />);
    expect(await screen.findByRole('heading', { name: 'รายงานผู้บริหาร' })).not.toBeNull();
    expect(screen.getByText('งานประชุมประจำปี')).not.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('keeps the selected section when the date preset changes', async () => {
  window.history.replaceState(null, '', '/?screen=executive-report');
  try {
    render(<LocalDemoApp />);
    const tabs = await screen.findByRole('navigation', { name: 'หมวดรายงาน' });
    fireEvent.click(within(tabs).getByRole('button', { name: 'ปริมาณส่ง' }));
    fireEvent.click(screen.getByRole('button', { name: 'วันนี้' }));
    expect(within(tabs).getByRole('button', { name: 'ปริมาณส่ง' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('table', { name: 'ปริมาณงานและน้ำแข็ง' })).not.toBeNull();
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

it('shows an error and retries when the report request rejects', async () => {
  rpc.mockRejectedValueOnce(new Error('เครือข่ายขัดข้อง'));
  render(<ExecutiveReportsPage isActive />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('เครือข่ายขัดข้อง'));
  expect(screen.queryByText('กำลังโหลดรายงาน…')).toBeNull();
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'ลองใหม่' }));
  expect(await screen.findByText('อาคาร A')).not.toBeNull();
});

it('recovers from an invoice request failure and keeps the detail navigation', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(screen.getByRole('button', { name: /ยอดขายสุทธิช่วงนี้/ }));
  const dialog = await screen.findByRole('dialog');
  const row = await within(dialog).findByRole('button', { name: /ร้านหนึ่ง/ });
  rpc.mockRejectedValueOnce(new Error('โหลดบิลขัดข้อง'));
  fireEvent.click(row);
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'โหลดบิลขัดข้อง');
  fireEvent.click(within(dialog).getByRole('button', { name: 'กลับไปยังรายการ' }));
  expect(await within(dialog).findByRole('button', { name: /ร้านหนึ่ง/ })).not.toBeNull();
});

it('traps keyboard focus in the detail panel and closes with Escape', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  const metric = screen.getByRole('button', { name: /หนี้ค้างปัจจุบัน/ });
  fireEvent.click(metric);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('ทั้งหมด 1 รายการ');
  const last = within(dialog).getAllByRole('button').filter((button) => !button.hasAttribute('disabled')).slice(-1)[0];
  last.focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'ย้อนกลับไปยังรายงาน' }));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(metric));
  expect(screen.queryByRole('dialog')).toBeNull();
});


it.each([
  ['2024-01-15', '2024-03-10', '2024-01-01', 'ม.ค. 2567', '2024-01-15', '2024-01-31'],
  ['2024-01-15', '2024-03-10', '2024-02-01', 'ก.พ. 2567', null, null],
  ['2024-01-15', '2024-03-10', '2024-03-01', 'มี.ค. 2567', '2024-03-01', '2024-03-10'],
  ['2024-01-01', '2024-01-31', '2024-01-01', null, null, null],
  ['2024-01-01', '2024-02-01', '2024-01-01', 'ม.ค. 2567', null, null],
])('labels trend buckets for %s to %s at %s', async (from, to, bucket, month, start, end) => {
  const original = rpc.getMockImplementation();
  rpc.mockImplementation(async (name: string, args: unknown) => {
    const result = await original?.(name, args);
    if (name !== 'get_executive_report') return result;
    return { ...result, data: { ...result.data, from, to,
      trend: [{ date: bucket, sales: 500, receipts: 300, refunds: 20 }],
    } };
  });
  render(<ExecutiveReportsPage isActive />);
  fireEvent.change(screen.getByLabelText('จาก'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('ถึง'), { target: { value: to } });
  const graph = await screen.findByRole('group', { name: 'กราฟยอดขาย' });
  const label = month
    ? start && end ? `${month} (${formatReportDate(start)} – ${formatReportDate(end)})` : month
    : formatReportDate(bucket);
  fireEvent.click(within(graph).getByRole('button'));
  expect(within(await screen.findByRole('dialog')).getByRole('heading').textContent).toBe(label);
  expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
    p_from: from, p_to: to, p_bucket: bucket,
  }));
  fireEvent.click(screen.getByRole('button', { name: 'ปิดรายละเอียด' }));
  expect(within(graph).getByRole('button').getAttribute('aria-label')).toContain(label);
  fireEvent.click(screen.getByRole('button', { name: 'ดูตารางตัวเลข' }));
  expect(within(screen.getByRole('table', { name: 'ตารางแนวโน้ม' })).getByText(label)).not.toBeNull();
});


it('uses monthly headings after selecting the year preset', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-03-10T05:00:00Z'));
  try {
    const original = rpc.getMockImplementation();
    rpc.mockImplementation(async (name: string, args: { p_from?: string; p_to?: string }) => {
      const result = await original?.(name, args);
      if (name !== 'get_executive_report') return result;
      return { ...result, data: { ...result.data, from: args.p_from, to: args.p_to,
        trend: [{ date: args.p_from, sales: 500, receipts: 300, refunds: 20 }],
      } };
    });
    render(<ExecutiveReportsPage isActive />);
    await screen.findByText('อาคาร A');
    fireEvent.click(screen.getByRole('button', { name: 'ปีนี้' }));
    const graph = await screen.findByRole('group', { name: 'กราฟยอดขาย' });
    fireEvent.click(within(graph).getByRole('button', { name: 'ม.ค. 2567 ฿500' }));
    expect(within(await screen.findByRole('dialog')).getByRole('heading').textContent).toBe('ม.ค. 2567');
    expect(rpc).toHaveBeenCalledWith('get_executive_report_details', expect.objectContaining({
      p_from: '2024-01-01', p_to: '2024-03-10', p_bucket: '2024-01-01',
    }));
  } finally {
    vi.useRealTimers();
  }
});

it('shows the overall volume followed by each building and separate other activity without extra controls', async () => {
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  rpc.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณส่ง' }));
  const total = screen.getByRole('table', { name: 'ปริมาณงานและน้ำแข็ง' });
  expect(within(total).getByText('10')).not.toBeNull();
  const buildings = screen.getByRole('region', { name: 'แยกตามตึก' });
  const a = within(buildings).getByRole('table', { name: 'ปริมาณน้ำแข็ง · อาคาร A' });
  const b = within(buildings).getByRole('table', { name: 'ปริมาณน้ำแข็ง · อาคาร B' });
  expect(within(a).getByText('6.5')).not.toBeNull();
  expect(within(a).getByText('0.5')).not.toBeNull();
  expect(within(b).getByText('2.5')).not.toBeNull();
  expect(within(buildings).queryByText('ขายหน้ารถ')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'รายการอื่นในยอดรวม' })).getByRole('table', { name: 'ปริมาณน้ำแข็ง · ขายหน้ารถ' })).not.toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});

it('distinguishes missing building data from an empty period', async () => {
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (name: string, args: unknown) => {
    const result = await original(name, args);
    if (name === 'get_executive_report') delete result.data.volumeAreas;
    return result;
  });
  render(<ExecutiveReportsPage isActive />);
  await screen.findByText('อาคาร A');
  fireEvent.click(screen.getByRole('button', { name: 'ปริมาณส่ง' }));
  expect(screen.getByText('ข้อมูลแยกตึกยังไม่พร้อมใช้งาน')).not.toBeNull();
  expect(within(screen.getByRole('table', { name: 'ปริมาณงานและน้ำแข็ง' })).getByText('10')).not.toBeNull();
});

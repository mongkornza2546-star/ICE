import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExecutiveReportsPage } from '../src/features/reports/ExecutiveReportsPage';
import { LocalDemoApp } from '../src/LocalDemoApp';
import { presetDates } from '../src/features/reports/reportDates';

const { rpc, writeXlsxFile } = vi.hoisted(() => ({ rpc: vi.fn(), writeXlsxFile: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('write-excel-file', () => ({ default: writeXlsxFile }));

beforeEach(() => {
  const { from, to } = presetDates('month');
  rpc.mockReset();
  writeXlsxFile.mockReset();
  rpc.mockImplementation((name: string, args: { p_metric?: string; p_bucket?: string }) => Promise.resolve({
    error: null,
    data: name === 'get_executive_report_invoice' ? {
      number: 'C-001', shop: 'ร้านหนึ่ง', serviceDate: from, area: 'อาคาร A',
      dueDate: from, total: 500, paid: 200,
      items: [{ name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity: 10 }],
      payments: [{ date: new Date().toISOString(), method: 'cash', amount: 200 }],
    } : name === 'get_executive_report' ? {
      from, to, asOf: new Date().toISOString(), previousFrom: from, previousTo: to,
      sales: 500, receipts: 300, refunds: 20, netReceipts: 280,
      previousSales: 250, previousNetReceipts: 140,
      outstanding: 180, overdue: 80, debtors: 2, deliveryCount: 4,
      trend: [{ date: from, sales: 500, receipts: 300, refunds: 20 }],
      areas: [{ kind: 'building', id: 'building-1', name: 'อาคาร A', sales: 500 }],
      shops: [{ id: 'shop-1', name: 'ร้านหนึ่ง', sales: 500 }],
      products: [{ id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', delivered: 10, damaged: 1 }],
    } : {
      total: 1,
      rows: [{ id: 'item-1', day: args.p_bucket ?? from, label: 'ร้านหนึ่ง',
        amount: args.p_metric === 'receipts' ? 300 : args.p_metric === 'refunds' ? 20
          : args.p_metric === 'debt' ? 180 : 500,
        area: 'อาคาร A', shopId: 'shop-1' }],
    },
  }));
});

it('shows business totals and drills into the selected building', async () => {
  render(<ExecutiveReportsPage isActive />);
  expect(await screen.findByText('อาคาร A')).not.toBeNull();
  expect(screen.getByText('หนี้ค้างปัจจุบัน')).not.toBeNull();
  expect(screen.getByText('น้ำแข็งหลอด')).not.toBeNull();
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
  expect(writeXlsxFile.mock.calls[0][1].sheets).toEqual(['สรุป', 'แนวโน้ม', 'พื้นที่', 'รายการ']);
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

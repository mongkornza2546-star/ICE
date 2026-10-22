import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), print: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  rpc: mocks.rpc, storage: { from: () => ({ getPublicUrl: vi.fn() }) },
} }));
vi.mock('../src/lib/thermalPrinter', () => ({ isAndroidApp: () => true }));
vi.mock('../src/lib/dailyCreditAcknowledgementPrint', () => ({
  printDailyCreditAcknowledgementForCurrentPlatform: mocks.print,
}));
import { DailyCreditAcknowledgementPanel } from '../src/features/financial-operations/components/DailyCreditAcknowledgementPanel';
import { publishDataChange } from '../src/lib/dataChange';
import { createRealtimeSync } from '../src/lib/realtimeSync';

const invoice = {
  document_number: 'INV-001', recorded_at: '2026-10-22T06:00:00Z', recorded_by: 'พนักงาน',
  total_amount: 120, items: [{ ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง', quantity: 4, unit_price: 30, line_total: 120 }],
};
const shop = {
  shop_id: 'shop-1', shop_code: 'BB47', shop_name: 'Mikka', image_path: null,
  invoice_count: 1, total_amount: 120, latest_delivery_at: invoice.recorded_at,
  open_round_count: 1, document_id: 'doc-1', document_version: 1,
  is_stale: false, evidence_count: 1, latest_evidence_path: 'signed.webp',
};
const document = {
  document_id: 'doc-1', version: 1, service_date: '2026-10-22',
  document_title: 'ใบส่งของ', generated_at: invoice.recorded_at,
  shop_code: shop.shop_code, shop_name: shop.shop_name,
  total_amount: 120, invoices: [invoice], item_totals: [],
};
const newInvoice = { ...invoice, document_number: 'INV-002', recorded_at: '2026-10-22T07:00:00Z' };
const updatedDocument = { ...document, document_id: 'doc-2', version: 2, total_amount: 240, invoices: [invoice, newInvoice] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.print.mockReset().mockResolvedValue(true);
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'list_daily_credit_acknowledgements') return { data: [shop], error: null };
    if (name === 'get_daily_credit_acknowledgement_details') return { data: [invoice], error: null };
    if (name === 'prepare_daily_credit_acknowledgement') return { data: document, error: null };
    throw new Error(name);
  });
});

it('keeps details visible and makes only the prepare request on every print', async () => {
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  const originalInvoice = await screen.findByText('INV-001');
  const user = userEvent.setup();
  for (const button of ['พิมพ์ไม่แสดง VAT', 'พิมพ์ซ้ำ']) {
    mocks.rpc.mockClear();
    await user.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(screen.getByRole('button', { name: button })).toHaveProperty('disabled', false));
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['prepare_daily_credit_acknowledgement']);
    expect(screen.getByText('INV-001')).toBe(originalInvoice);
    expect(screen.queryByText('กำลังโหลดรายละเอียด...')).toBeNull();
    expect(screen.getByText('ฉบับที่ 1 · มีรูปใบเซ็น 1 รูป')).toBeTruthy();
  }
  expect(mocks.print).toHaveBeenCalledTimes(2);
});

it('uses the prepared document for new totals, details and version, and clears evidence from the old version', async () => {
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.rpc.mockResolvedValueOnce({ data: updatedDocument, error: null });
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  expect(await screen.findByText('INV-002')).toBeTruthy();
  expect(screen.getByText('รวม 2 INV')).toBeTruthy();
  expect(screen.getByText('ฉบับที่ 2')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'ดูรูป' })).toBeNull();
  expect(screen.getAllByText('฿240.00')).toHaveLength(2);
  expect(mocks.print).toHaveBeenCalledWith(expect.objectContaining(updatedDocument), null, { showVat: false });
});

it('does not let an older detail response overwrite the prepared invoices', async () => {
  const pending = deferred<{ data: typeof invoice[]; error: null }>();
  mocks.rpc.mockResolvedValueOnce({ data: [shop], error: null }).mockReturnValueOnce(pending.promise);
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('กำลังโหลดรายละเอียด...');
  mocks.rpc.mockResolvedValueOnce({ data: updatedDocument, error: null });
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  await act(async () => { pending.resolve({ data: [invoice], error: null }); });
  expect(await screen.findByText('INV-002')).toBeTruthy();
  expect(screen.queryByText('กำลังโหลดรายละเอียด...')).toBeNull();
});

it('still refreshes details when receivables actually change', async () => {
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  mocks.rpc.mockClear();
  mocks.rpc.mockResolvedValueOnce({ data: [{ ...shop, total_amount: 240, invoice_count: 2 }], error: null })
    .mockResolvedValueOnce({ data: [invoice, newInvoice], error: null });
  await act(async () => publishDataChange(['receivable']));
  expect(await screen.findByText('INV-002')).toBeTruthy();
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
    'list_daily_credit_acknowledgements', 'get_daily_credit_acknowledgement_details',
  ]);
});

it('keeps existing details and allows retry if printing fails', async () => {
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.print.mockRejectedValueOnce(new Error('เครื่องพิมพ์ไม่พร้อม'));
  mocks.rpc.mockClear();
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'เครื่องพิมพ์ไม่พร้อม');
  expect(screen.getByText('INV-001')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' })).toHaveProperty('disabled', false);
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['prepare_daily_credit_acknowledgement']);
});

it('does not apply a delayed prepare response after navigating to another date', async () => {
  const pending = deferred<{ data: typeof updatedDocument; error: null }>();
  const { rerender } = render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.rpc.mockReturnValueOnce(pending.promise);
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  rerender(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-23" />);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_daily_credit_acknowledgement_details', {
    p_shop_id: 'shop-1', p_service_date: '2026-10-23',
  }));
  await screen.findByText('INV-001');
  await act(async () => pending.resolve({ data: updatedDocument, error: null }));
  expect(screen.queryByText('INV-002')).toBeNull();
  expect(screen.getByText('ฉบับที่ 1 · มีรูปใบเซ็น 1 รูป')).toBeTruthy();
});

it('does not overwrite newer receivables when a slow printer finishes', async () => {
  const pending = deferred<boolean>();
  mocks.print.mockReturnValueOnce(pending.promise);
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  expect(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' })).toHaveProperty('disabled', true);
  mocks.rpc.mockResolvedValueOnce({ data: [{ ...shop, total_amount: 240, invoice_count: 2, is_stale: true }], error: null })
    .mockResolvedValueOnce({ data: [invoice, newInvoice], error: null });
  await act(async () => publishDataChange(['receivable']));
  await screen.findByText('INV-002');
  mocks.rpc.mockClear();
  await act(async () => pending.resolve(true));
  expect(screen.getByText('INV-002')).toBeTruthy();
  expect(screen.getByText(/ยอดเปลี่ยน · พิมพ์ฉบับใหม่/)).toBeTruthy();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('keeps the newly prepared summary when navigating back while prepare is pending', async () => {
  const pending = deferred<{ data: typeof updatedDocument; error: null }>();
  render(<DailyCreditAcknowledgementPanel serviceDate="2026-10-22" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /BB47/ }));
  await screen.findByText('INV-001');
  mocks.rpc.mockReturnValueOnce(pending.promise);
  await user.click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  await user.click(screen.getByRole('button', { name: 'กลับรายชื่อร้าน' }));
  await screen.findByLabelText('วันที่');
  await act(async () => pending.resolve({ data: updatedDocument, error: null }));
  expect(mocks.print).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), null, { showVat: false });
  expect(screen.getByText(/ฉบับที่ 2/)).toBeTruthy();
});

it('does not let a list request started before prepare replace its newer summary', async () => {
  const pendingList = deferred<{ data: typeof shop[]; error: null }>();
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.rpc.mockReturnValueOnce(pendingList.promise);
  await act(async () => publishDataChange(['receivable']));
  mocks.rpc.mockResolvedValueOnce({ data: updatedDocument, error: null });
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  expect(await screen.findByText('ฉบับที่ 2')).toBeTruthy();
  mocks.rpc.mockResolvedValueOnce({ data: [invoice, newInvoice], error: null });
  await act(async () => pendingList.resolve({ data: [shop], error: null }));
  await screen.findByText('INV-002');
  expect(screen.getByText('ฉบับที่ 2')).toBeTruthy();
  expect(screen.getAllByText('฿240.00')).toHaveLength(2);
});

it.each(['before', 'after'])('does not reload when its own realtime INSERT arrives %s the prepare response', async (timing) => {
  const callbacks = new Map<string, (payload?: unknown) => void>();
  const channel = {
    on: vi.fn((_event: string, filter: { table: string }, callback: (payload?: unknown) => void) => {
      callbacks.set(filter.table, callback);
      return channel;
    }),
    subscribe: vi.fn(),
  };
  const client = { channel: () => channel, removeChannel: vi.fn() };
  const stop = createRealtimeSync(client as unknown as Parameters<typeof createRealtimeSync>[0], undefined, {
    debounceMs: 0, enableFocusCatchup: false,
  });
  try {
    render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
    await screen.findByText('INV-001');
    mocks.rpc.mockClear();
    const pending = deferred<{ data: typeof updatedDocument; error: null }>();
    mocks.rpc.mockReturnValueOnce(pending.promise);
    await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
    if (timing === 'after') await act(async () => pending.resolve({ data: updatedDocument, error: null }));
    await act(async () => {
      callbacks.get('daily_credit_acknowledgements')!({ eventType: 'INSERT', new: { id: 'doc-2', shop_id: 'shop-1', service_date: '2026-10-22' } });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (timing === 'before') await act(async () => pending.resolve({ data: updatedDocument, error: null }));
    await screen.findByText('INV-002');
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['prepare_daily_credit_acknowledgement']);
    expect(screen.queryByText('กำลังโหลดรายละเอียด...')).toBeNull();
  } finally { stop(); }
});

const ownInsert = { table: 'daily_credit_acknowledgements', eventType: 'INSERT', id: 'doc-2', shopId: 'shop-1', serviceDate: '2026-10-22' };

it.each(['other-document', 'mixed-delivery', 'document-update'])('still refreshes a %s event after printing', async (scenario) => {
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.rpc.mockResolvedValueOnce({ data: updatedDocument, error: null });
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  mocks.rpc.mockClear();
  mocks.rpc.mockResolvedValueOnce({ data: [{ ...shop, document_id: 'doc-3', document_version: 3 }], error: null })
    .mockResolvedValueOnce({ data: [invoice], error: null });
  const changes = scenario === 'other-document' ? [{ ...ownInsert, id: 'doc-3' }]
    : scenario === 'document-update' ? [{ ...ownInsert, eventType: 'UPDATE' }]
      : [ownInsert, { table: 'delivery_charges', eventType: 'INSERT', id: 'charge-2' }];
  await act(async () => publishDataChange(['receivable'], changes));
  expect(await screen.findByText(/ฉบับที่ 3/)).toBeTruthy();
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
    'list_daily_credit_acknowledgements', 'get_daily_credit_acknowledgement_details',
  ]);
});

it.each(['success', 'failure'])('reconciles a different document received while prepare is pending on %s', async (outcome) => {
  const pending = deferred<{ data: typeof document | null; error: { message: string } | null }>();
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.rpc.mockReturnValueOnce(pending.promise);
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  mocks.rpc.mockClear();
  await act(async () => publishDataChange(['receivable'], [ownInsert]));
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValueOnce({ data: [{ ...shop, document_id: 'doc-2', document_version: 2 }], error: null })
    .mockResolvedValueOnce({ data: [invoice], error: null });
  await act(async () => pending.resolve(outcome === 'success'
    ? { data: document, error: null } : { data: null, error: { message: 'เตรียมใบไม่สำเร็จ' } }));
  expect(await screen.findByText(/ฉบับที่ 2/)).toBeTruthy();
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
    'list_daily_credit_acknowledgements', 'get_daily_credit_acknowledgement_details',
  ]);
});

it('keeps other shops from an in-flight list refresh while preserving the prepared shop', async () => {
  const pendingList = deferred<{ data: typeof shop[]; error: null }>();
  render(<DailyCreditAcknowledgementPanel serviceDate="2026-10-22" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /BB47/ }));
  await screen.findByText('INV-001');
  mocks.rpc.mockReturnValueOnce(pendingList.promise);
  await act(async () => publishDataChange(['receivable']));
  mocks.rpc.mockResolvedValueOnce({ data: updatedDocument, error: null });
  await user.click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  await screen.findByText('ฉบับที่ 2');
  await user.click(screen.getByRole('button', { name: 'กลับรายชื่อร้าน' }));
  await screen.findByLabelText('วันที่');
  await act(async () => pendingList.resolve({ data: [shop, { ...shop, shop_id: 'shop-2', shop_code: 'BB48', shop_name: 'Another shop' }], error: null }));
  expect(await screen.findByRole('button', { name: /BB48/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /BB47/ }).textContent).toContain('ฉบับที่ 2');
  expect(screen.getByRole('button', { name: /BB47/ }).textContent).toContain('฿240.00');
});

it('reconciles a real delivery change during prepare instead of applying an older print snapshot', async () => {
  const pending = deferred<{ data: typeof document; error: null }>();
  render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await screen.findByText('INV-001');
  mocks.rpc.mockReturnValueOnce(pending.promise);
  await userEvent.setup().click(screen.getByRole('button', { name: 'พิมพ์ไม่แสดง VAT' }));
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'list_daily_credit_acknowledgements'
    ? [{ ...shop, total_amount: 240, invoice_count: 2, document_id: 'doc-2', document_version: 2 }]
    : [invoice, newInvoice], error: null }));
  await act(async () => publishDataChange(['receivable'], [{ table: 'delivery_charges', eventType: 'INSERT', id: 'charge-2' }]));
  await screen.findByText('INV-002');
  mocks.rpc.mockClear();
  await act(async () => pending.resolve({ data: document, error: null }));
  expect(await screen.findByText('INV-002')).toBeTruthy();
  expect(screen.getByText(/ฉบับที่ 2/)).toBeTruthy();
  expect(screen.getAllByText('฿240.00')).toHaveLength(2);
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
    'list_daily_credit_acknowledgements', 'get_daily_credit_acknowledgement_details',
  ]);
});

it('ignores a delayed list response for the previous date', async () => {
  const pending = deferred<{ data: typeof shop[]; error: null }>();
  mocks.rpc.mockReturnValueOnce(pending.promise);
  const { rerender } = render(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-22" />);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('list_daily_credit_acknowledgements', { p_service_date: '2026-10-22' }));
  rerender(<DailyCreditAcknowledgementPanel shopId="shop-1" serviceDate="2026-10-23" />);
  await screen.findByText('INV-001');
  await act(async () => pending.resolve({ data: [{ ...shop, total_amount: 999, document_version: 99 }], error: null }));
  expect(screen.queryByText('฿999.00')).toBeNull();
  expect(screen.getByText('ฉบับที่ 1 · มีรูปใบเซ็น 1 รูป')).toBeTruthy();
});

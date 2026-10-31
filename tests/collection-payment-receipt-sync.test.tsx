import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { offlineSnapshot } from './helpers/offlineSnapshot';
import { OfflineEngine, type SyncResponse } from '../src/offline/runtime/engine';
import { WorkStore } from '../src/offline/runtime/store';
import type { EmployeeRuntime } from '../src/offline/runtime/client';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), print: vi.fn(), android: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../src/lib/salesDocumentPrint', () => ({ printSalesDocumentForCurrentPlatform: mocks.print }));
vi.mock('../src/lib/thermalPrinter', () => ({ isAndroidApp: mocks.android }));
import { FinancialOperations } from '../src/FinancialOperations';

let store: WorkStore;
let runtime: EmployeeRuntime;
let send: ReturnType<typeof vi.fn>;
const confirmed = {
  payment_id: 'payment-confirmed', receipt_number: 'REC-001', recorded_at: '2026-10-29T02:00:01Z',
  received_amount: 100, allocated_amount: 75, change_amount: 25,
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-29T02:00:00Z');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  mocks.android.mockReturnValue(true);
  mocks.print.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ error: null, data: {
    ...confirmed, shop_code: 'BB1', shop_name: 'ร้านทดสอบ', payment_method: 'cash',
    charges: [{ charge_number: 'INV-001', received_amount: 75,
      items: [{ ice_type_name: 'น้ำแข็ง', ice_type_unit: 'ถุง', quantity: 3, unit_price: 25, line_total: 75 }] }],
  } });
  const snapshot = offlineSnapshot();
  snapshot.collection.queue = [{
    shop_id: 'shop', shop_code: 'BB1', shop_name: 'ร้านทดสอบ', image_path: null,
    outstanding_amount: 75, charge_count: 1, has_new_charges: true,
    payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false, bank_transfer_reference_required: false,
      bank_transfer_evidence_required: false, qr_reference_required: false, qr_evidence_required: false },
    charges: [{ charge_id: 'charge', charge_number: 'INV-001', service_date: snapshot.serviceDate,
      original_amount: 75, outstanding_amount: 75, items: [] }],
  }];
  store = new WorkStore(new IDBFactory(), 'receipt-sync');
  send = vi.fn(async (): Promise<SyncResponse> => ({ status: 'applied', result: confirmed }));
  const engine = new OfflineEngine(snapshot.ownerId, snapshot.serviceDate, store, { send, resolutions: async () => [] });
  await engine.install(snapshot);
  runtime = { engine, snapshot: async () => engine.getSnapshot().snapshot, tick: vi.fn(async () => {}),
    prepare: vi.fn(async () => {}), start: () => () => {} };
});

afterEach(async () => {
  runtime.engine.dispose();
  await store.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function openPayment() {
  render(<FinancialOperations offlineRuntime={runtime} userRole="courier" serviceDate={runtime.engine.day} />);
  fireEvent.click(await screen.findByRole('button', { name: /BB1.*ร้านทดสอบ/ }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }), { target: { value: '100' } });
}

async function collectPayment() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await openPayment();
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await screen.findByText('บันทึกลงเครื่องแล้ว · รอซิงก์');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
}

it.each([true, false])('enables printing the confirmed receipt without reopening the payment screen (Android: %s)', async (android) => {
  mocks.android.mockReturnValue(android);
  const printWindow = { close: vi.fn() } as unknown as Window;
  const open = vi.spyOn(window, 'open').mockReturnValue(printWindow);
  await collectPayment();
  expect(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }).hasAttribute('disabled')).toBe(true);
  await act(async () => { await runtime.engine.sync(); });
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('applied');
  await waitFor(() => expect(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }));
  await waitFor(() => expect(mocks.print).toHaveBeenCalledWith(expect.objectContaining({
    documentNumber: 'REC-001', totals: { total: 75, received: 100, change: 25 },
    items: [expect.objectContaining({ name: 'น้ำแข็ง', quantity: 3, lineTotal: 75 })],
  }), android ? null : printWindow));
  expect(mocks.rpc).toHaveBeenCalledWith('get_payment_receipt_snapshot', { p_payment_id: 'payment-confirmed' });
  expect(open).toHaveBeenCalledTimes(android ? 0 : 1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await store.commands(runtime.engine.owner)).toHaveLength(1);
  expect(screen.queryByText('บันทึกลงเครื่องแล้ว · รอซิงก์')).toBeNull();
});

it('does not enable an official receipt for a rejected payment', async () => {
  send.mockResolvedValue({ status: 'conflict', error: 'ยอดค้างเปลี่ยน' });
  await collectPayment();
  await act(async () => { await runtime.engine.sync(); });
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('conflict');
  fireEvent.click(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }));
  expect(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }).hasAttribute('disabled')).toBe(true);
  expect(mocks.print).not.toHaveBeenCalled();
});

it('reconciles a sync that completes before the local receipt is rendered', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const enqueue = runtime.engine.enqueue.bind(runtime.engine);
  vi.spyOn(runtime.engine, 'enqueue').mockImplementation(async (input) => {
    const command = await enqueue(input);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await runtime.engine.sync();
    return command;
  });
  await openPayment();
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
  await screen.findByText('บันทึกรับเงินเรียบร้อย');
  expect(screen.getByRole('button', { name: 'พิมพ์ใบเสร็จ' }).hasAttribute('disabled')).toBe(false);
});

it('does not reopen a dismissed payment when background sync completes', async () => {
  await collectPayment();
  fireEvent.click(screen.getByRole('button', { name: 'เสร็จสิ้น' }));
  await act(async () => { await runtime.engine.sync(); });
  expect(runtime.engine.getSnapshot().commands[0].status).toBe('applied');
  expect(screen.queryByRole('button', { name: 'พิมพ์ใบเสร็จ' })).toBeNull();
  expect(mocks.print).not.toHaveBeenCalled();
});

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialOperations } from '../src/FinancialOperations';
import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import { ManagerFinancialSections } from '../src/features/financial-operations/components/FinancialOperationsPanels';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  createSignedUrls: vi.fn(),
  uploadPaymentEvidence: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: {
      from: () => ({ createSignedUrls: mocks.createSignedUrls }),
    },
  },
}));

vi.mock('../src/lib/paymentEvidence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/paymentEvidence')>()),
  uploadPaymentEvidence: mocks.uploadPaymentEvidence,
}));

function queryResult(data: unknown, error: { message: string } | null = null) {
  const result = { data, error };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'lt', 'order', 'limit']) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.then = (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
}

function deferredQueryResult() {
  let resolve!: (result: { data: unknown; error: { message: string } | null }) => void;
  const result = new Promise<{ data: unknown; error: { message: string } | null }>((nextResolve) => {
    resolve = nextResolve;
  });
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'lt', 'order', 'limit']) query[method] = vi.fn(() => query);
  query.then = result.then.bind(result);
  return { query, resolve };
}

function mockReceiptPrintWindow() {
  const printDocument = document.implementation.createHTMLDocument('ใบเสร็จ');
  const print = vi.fn();
  const close = vi.fn();
  vi.spyOn(window, 'open').mockReturnValue({
    document: printDocument,
    addEventListener: vi.fn(),
    focus: vi.fn(),
    print,
    close,
  } as unknown as Window);
  return { close, printDocument, print };
}

const queueShop = {
  shop_id: 'shop-1',
  shop_code: 'S001',
  shop_name: 'ร้านเก็บเงิน',
  image_path: 'shops/shop-1.webp',
  outstanding_amount: 100,
  charge_count: 2,
  has_new_charges: false,
  payment_profile: {
    allowed_payment_methods: ['cash'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: true,
    bank_transfer_evidence_required: false,
    qr_reference_required: true,
    qr_evidence_required: false,
  },
  charges: [
    {
      charge_id: 'charge-1',
      charge_number: 'C260728-000001',
      service_date: '2026-07-28',
      original_amount: 60,
      outstanding_amount: 60,
      items: [{
        ice_type_id: 'ice-1',
        name: 'น้ำแข็งหลอด',
        unit: 'ถุง',
        quantity: 2,
        line_total: 60,
      }],
    },
    {
      charge_id: 'charge-2',
      charge_number: 'C260728-000002',
      service_date: '2026-07-28',
      original_amount: 40,
      outstanding_amount: 40,
      items: [{
        ice_type_id: 'ice-2',
        name: 'น้ำแข็งป่น',
        unit: 'ถุง',
        quantity: 1,
        line_total: 40,
      }],
    },
  ],
};

describe('FinancialOperations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.from.mockReset();
    mocks.rpc.mockReset();
    mocks.createSignedUrls.mockReset();
    mocks.uploadPaymentEvidence.mockReset();
    mocks.createSignedUrls.mockResolvedValue({ data: [], error: null });
    mocks.uploadPaymentEvidence.mockResolvedValue('courier-1/payment-slip.jpg');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('initializes the automatically selected desktop shop with its payment defaults', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const transferShop = {
      ...queueShop,
      payment_profile: {
        ...queueShop.payment_profile,
        allowed_payment_methods: ['bank_transfer'],
        default_payment_method: 'bank_transfer',
        bank_transfer_evidence_required: false,
      },
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [transferShop], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);

    expect(await screen.findByRole('dialog', { name: 'รับเงิน ร้านเก็บเงิน' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'โอนเงิน' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' }) as HTMLInputElement).value).toBe('100.00');
  });

  it('applies document search, status filtering, and the all tab to the displayed rows', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const user = userEvent.setup();
    const onOpenReceipt = vi.fn();
    const onClearShop = vi.fn();
    const todayPayment = {
      id: 'payment-today',
      receipt_number: 'R260803-000001',
      received_amount: 100,
      allocated_amount: 100,
      change_amount: 0,
      payment_method: 'cash' as const,
      status: 'active' as const,
      recorded_at: '2026-08-03T02:00:00Z',
      void_reason: null,
      shops: { code: 'P001', name: 'ร้านจ่ายแล้ว' },
    };
    render(<CollectionDesk
      busy={false}
      historyDate="2026-08-03"
      onHistoryDateChange={() => undefined}
      onOpenReceipt={onOpenReceipt}
      onPrintReceipt={() => undefined}
      onRefresh={() => undefined}
      onClearShop={onClearShop}
      onSelectShop={() => undefined}
      onVoidPayment={() => undefined}
      paymentHistory={[todayPayment]}
      paymentPanel={null}
      queue={[queueShop]}
      runId="run-1"
      selectedShop={null}
      serviceDate="2026-08-03"
      todayPayments={[todayPayment]}
    />);

    const search = screen.getByPlaceholderText('ค้นหาร้านค้า / เลขที่เอกสาร');
    await user.type(search, 'C260728-000002');
    expect(screen.getByRole('button', { name: /S001 · ร้านเก็บเงิน/ })).not.toBeNull();

    await user.clear(search);
    await user.selectOptions(screen.getByRole('combobox', { name: 'สถานะ' }), 'collected');
    expect(screen.getByRole('tab', { name: /ประวัติรับเงิน 1/ })).not.toBeNull();
    expect(screen.queryByRole('tab', { name: /เก็บเงินแล้ววันนี้/ })).toBeNull();
    expect(screen.getByText(/R260803-000001/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /S001 · ร้านเก็บเงิน/ })).toBeNull();
    expect(screen.getByText('ประเภทรายการ')).not.toBeNull();
    expect(screen.getByText('ยอดเงิน')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /เลือกรายการ P001 · ร้านจ่ายแล้ว/ }));
    expect(screen.getByLabelText('รายละเอียด R260803-000001')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ดูบิล' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'พิมพ์ซ้ำ' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ยกเลิกรายการ' })).not.toBeNull();
    expect(onOpenReceipt).not.toHaveBeenCalled();
    expect(onClearShop).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('tab', { name: /ค้างชำระทั้งหมด/ }));
    expect(screen.queryByLabelText('รายละเอียด R260803-000001')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'ทั้งหมด' }));
    expect(screen.getByText(/R260803-000001/)).not.toBeNull();
    expect(screen.getByRole('button', { name: /S001 · ร้านเก็บเงิน/ })).not.toBeNull();
  });

  it('opens paid-row details with every manager action on smaller screens', async () => {
    const user = userEvent.setup();
    const payment = {
      id: 'payment-mobile', receipt_number: 'R260803-000009', received_amount: 100,
      allocated_amount: 100, change_amount: 0, payment_method: 'cash' as const,
      status: 'active' as const, recorded_at: '2026-08-03T02:00:00Z', void_reason: null,
      shops: { code: 'P009', name: 'ร้านมือถือ' },
    };
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    render(<FinancialOperations
      demoData={{ serviceDate: '2026-08-03', queue: [], paymentHistory: [payment] }}
      userRole="round_lead"
    />);

    await user.click(screen.getByRole('tab', { name: /ประวัติรับเงิน/ }));
    await user.click(screen.getByRole('button', { name: /เลือกรายการ P009 · ร้านมือถือ/ }));
    const dialog = await screen.findByRole('dialog', { name: 'รายละเอียดใบเสร็จ R260803-000009' });
    expect(dialog).not.toBeNull();
    expect(screen.getByRole('button', { name: 'พิมพ์ซ้ำ' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ยกเลิกรายการ' })).not.toBeNull();
  });

  it('labels a shop-level outstanding total from the complete payment-term mix', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const mixedShop = {
      ...queueShop,
      charges: queueShop.charges.map((charge, index) => ({
        ...charge,
        payment_term: index === 0 ? 'credit' as const : 'immediate' as const,
      })),
    };

    render(<CollectionDesk
      busy={false}
      historyDate="2026-08-03"
      onClearShop={() => undefined}
      onHistoryDateChange={() => undefined}
      onOpenReceipt={() => undefined}
      onPrintReceipt={() => undefined}
      onRefresh={() => undefined}
      onSelectShop={() => undefined}
      onVoidPayment={() => undefined}
      paymentHistory={[]}
      paymentPanel={null}
      queue={[mixedShop]}
      runId="run-1"
      selectedShop={null}
      serviceDate="2026-08-03"
      todayPayments={[]}
    />);

    expect(screen.getByText('ค้างชำระ (ผสม)')).not.toBeNull();
  });

  it('shows payment history one day at a time and navigates to earlier days', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const user = userEvent.setup();
    const todayPayment = {
      id: 'payment-today', receipt_number: 'R260803-000001', received_amount: 100,
      allocated_amount: 100, change_amount: 0, payment_method: 'cash' as const,
      status: 'active' as const, recorded_at: '2026-08-03T02:00:00Z', void_reason: null,
      shops: { code: 'P001', name: 'ร้านวันนี้' },
    };
    const previousPayment = {
      ...todayPayment,
      id: 'payment-previous',
      receipt_number: 'R260802-000001',
      recorded_at: '2026-08-02T02:00:00Z',
      shops: { code: 'P002', name: 'ร้านเมื่อวาน' },
    };

    render(<FinancialOperations
      demoData={{ serviceDate: '2026-08-03', queue: [queueShop], paymentHistory: [todayPayment, previousPayment] }}
      userRole="round_lead"
    />);

    await user.click(screen.getByRole('tab', { name: /ประวัติรับเงิน/ }));
    expect(screen.getByText(/R260803-000001/)).not.toBeNull();
    expect(screen.queryByText(/R260802-000001/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /เลือกรายการ P001 · ร้านวันนี้/ }));
    expect(screen.getByRole('button', { name: 'พิมพ์ซ้ำ' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ยกเลิกรายการ' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '‹ วันก่อนหน้า' }));
    expect(await screen.findByText(/R260802-000001/)).not.toBeNull();
    expect(screen.queryByText(/R260803-000001/)).toBeNull();
    expect((screen.getByLabelText('วันที่ประวัติรับเงิน') as HTMLInputElement).value).toBe('2026-08-02');

    await user.click(screen.getByRole('button', { name: 'วันถัดไป ›' }));
    expect(await screen.findByText(/R260803-000001/)).not.toBeNull();
  });

  it('opens courier payment history as a separate subpage from the collection navigation', async () => {
    const user = userEvent.setup();

    render(<FinancialOperations
      demoData={{ serviceDate: '2026-08-03', queue: [], paymentHistory: [] }}
      userRole="courier"
    />);

    expect(screen.getByRole('heading', { name: 'คิวเก็บเงินของฉัน' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'ประวัติรับเงิน' })).toBeNull();

    const historyNavigation = screen.getByRole('button', { name: 'ประวัติรับเงิน' });
    await user.click(historyNavigation);

    expect(historyNavigation.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'ประวัติรับเงินของฉัน' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'ประวัติรับเงิน' })).not.toBeNull();
    expect(screen.queryByText('รอบเก็บเงินท้ายวัน')).toBeNull();
  });

  it('keeps persisted receipt details and reprinting available to couriers', async () => {
    const user = userEvent.setup();
    const { printDocument, print } = mockReceiptPrintWindow();
    const payment = {
      id: 'payment-1', receipt_number: 'R260803-000002', received_amount: 100,
      allocated_amount: 100, change_amount: 0, payment_method: 'cash', status: 'active',
      recorded_at: '2026-08-03T02:00:00Z', void_reason: null,
      shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') return queryResult([payment]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      if (name === 'get_payment_receipt_items') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: 'ประวัติรับเงิน' }));
    await user.click(await screen.findByRole('button', { name: /ดูบิล R260803-000002/ }));
    expect(await screen.findByRole('dialog', { name: 'รายละเอียดใบเสร็จ R260803-000002' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'ปิดรายละเอียดใบเสร็จ' }));
    await user.click(await screen.findByRole('button', { name: 'พิมพ์ซ้ำ' }));

    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(printDocument.body.textContent).toContain('R260803-000002');
  });

  it('lets a manager void an active payment from the history tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('บันทึกยอดผิด');
    const payment = {
      id: 'payment-1', receipt_number: 'R260803-000003', received_amount: 100,
      allocated_amount: 100, change_amount: 0, payment_method: 'cash', status: 'active',
      recorded_at: '2026-08-03T02:00:00Z', void_reason: null,
      shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1', opened_at: '2026-08-03T01:00:00Z' });
      if (table === 'payments') return queryResult([payment]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'void_payment') return { data: { payment_id: 'payment-1' }, error: null };
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    await user.click(await screen.findByRole('tab', { name: /ประวัติรับเงิน/ }));
    await user.click(await screen.findByRole('button', { name: /เลือกรายการ S001 · ร้านเก็บเงิน/ }));
    await screen.findByRole('dialog', { name: 'รายละเอียดใบเสร็จ R260803-000003' });
    mocks.rpc.mockClear();
    await user.click(await screen.findByRole('button', { name: 'ยกเลิกรายการ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('void_payment', {
      p_payment_id: 'payment-1',
      p_reason: 'บันทึกยอดผิด',
    }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_collection_run_queue', {
      p_collection_run_id: 'run-1',
    }));
  });

  it('lets an assigned courier record a partial collection oldest-first', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
      if (name === 'record_payment') return {
        data: {
          payment_id: 'payment-1',
          receipt_number: 'R260729-000001',
          allocated_amount: 50,
          change_amount: 0,
          recorded_at: '2026-07-29T07:00:00Z',
        },
        error: null,
      };
      if (name === 'get_payment_receipt_items') return { data: [{
        charge_number: 'C260728-000001',
        received_amount: 100,
        ice_type_name: 'น้ำแข็งหลอด',
        ice_type_unit: 'ถุง',
        quantity: 2,
        line_total: 100,
      }], error: null };
      return { data: [], error: null };
    });
    mocks.createSignedUrls.mockResolvedValue({
      data: [{ path: 'shops/shop-1.webp', signedUrl: 'https://cdn.example.test/shops/shop-1.webp' }],
      error: null,
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    expect(await screen.findByRole('dialog', { name: 'รับเงิน ร้านเก็บเงิน' })).not.toBeNull();
    expect(screen.getByText('เลขที่บิล C260728-000001')).not.toBeNull();
    expect(screen.getByText('เลขที่บิล C260728-000002')).not.toBeNull();
    expect(screen.getAllByText('ยอดค้างจากวันอื่น')).toHaveLength(2);
    expect(screen.getByText('น้ำแข็งหลอด × 2 ถุง')).not.toBeNull();
    expect(screen.getByText('น้ำแข็งป่น × 1 ถุง')).not.toBeNull();
    expect(screen.getAllByText(/28 ก\.?ค\.? 2569/)).toHaveLength(2);
    expect(screen.getByAltText('ร้าน ร้านเก็บเงิน').getAttribute('src'))
      .toBe('https://cdn.example.test/shops/shop-1.webp');
    expect(mocks.rpc).toHaveBeenCalledWith('get_collection_run_queue', {
      p_collection_run_id: 'run-1',
    });
    const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' });
    const cashMethod = screen.getByRole('button', { name: 'เงินสด' });
    expect(cashMethod.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'โอนเงิน' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'QR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'พักยอด / เครดิต' })).toBeNull();
    await user.clear(amount);
    await user.type(amount, '50');
    await user.click(screen.getByRole('checkbox', { name: 'พิมพ์ใบรับเงินหลังบันทึก' }));
    await user.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_payment', expect.objectContaining({
      p_allocations: [
        { charge_id: 'charge-1', amount: 50 },
      ],
      p_received_amount: 50,
      p_collection_run_id: 'run-1',
      p_approval_id: null,
    })));
  });

  it('automatically prints the ordered items after payment is recorded when requested', async () => {
    const user = userEvent.setup();
    const { printDocument, print } = mockReceiptPrintWindow();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
      if (name === 'record_payment') return {
        data: {
          payment_id: 'payment-1',
          receipt_number: 'R260729-000001',
          allocated_amount: 100,
          change_amount: 400,
          recorded_at: '2026-07-29T07:00:00Z',
        },
        error: null,
      };
      if (name === 'get_payment_receipt_items') return { data: [{
        charge_number: 'C260728-000001',
        received_amount: 100,
        ice_type_name: 'น้ำแข็งหลอด',
        ice_type_unit: 'ถุง',
        quantity: 2,
        line_total: 100,
      }], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    expect(screen.queryByRole('button', { name: 'พิมพ์ใบเสร็จ' })).toBeNull();

    const amount = screen.getByRole('spinbutton', { name: 'ยอดรับเงินจริง' });
    await user.clear(amount);
    await user.type(amount, '500');
    await user.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());

    expect(printDocument.body.textContent).toContain('S001 · ร้านเก็บเงิน');
    expect(printDocument.body.textContent).toContain('น้ำแข็งหลอด × 2 ถุง');
    expect(printDocument.body.textContent).toContain('รายการสั่งซื้อ C260728-000001');
    expect(printDocument.body.textContent).toContain('ยอดชำระ฿100.00');
    expect(printDocument.body.textContent).toContain('รับเงิน ฿500.00 · เงินทอน ฿400.00');
    expect(printDocument.body.textContent).toContain('R260729-000001');
    expect(printDocument.head.textContent).toContain('@page { size: 57mm 43.5mm; margin: 0; }');
    expect(print).toHaveBeenCalledOnce();
  });

  it('keeps a recorded payment printable when receipt item details cannot be loaded', async () => {
    const user = userEvent.setup();
    const { close } = mockReceiptPrintWindow();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
      if (name === 'record_payment') return {
        data: {
          payment_id: 'payment-1',
          receipt_number: 'R260729-000001',
          allocated_amount: 100,
          change_amount: 0,
          recorded_at: '2026-07-29T07:00:00Z',
        },
        error: null,
      };
      if (name === 'get_payment_receipt_items') return {
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.get_payment_receipt_items' },
      };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    await user.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));

    expect(await screen.findByRole('button', { name: 'พิมพ์ใบเสร็จ' })).not.toBeNull();
    expect(screen.getByText('บันทึกรับเงินเรียบร้อย')).not.toBeNull();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('keeps the receipt open until close and refreshes history when Escape closes it', async () => {
    const user = userEvent.setup();
    let queueLoadCount = 0;
    let paymentQueryCount = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') paymentQueryCount += 1;
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') {
        queueLoadCount += 1;
        return { data: queueLoadCount === 1 ? [queueShop] : [], error: null };
      }
      if (name === 'record_payment') return {
        data: {
          payment_id: 'payment-1',
          receipt_number: 'R260729-000001',
          allocated_amount: 100,
          change_amount: 0,
          recorded_at: '2026-07-29T07:00:00Z',
        },
        error: null,
      };
      if (name === 'get_payment_receipt_items') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    await user.click(screen.getByRole('checkbox', { name: 'พิมพ์ใบรับเงินหลังบันทึก' }));
    await user.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));

    expect(await screen.findByText('บันทึกรับเงินเรียบร้อย')).not.toBeNull();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_payment_receipt_items', {
      p_payment_id: 'payment-1',
    }));
    expect(screen.getByRole('dialog', { name: 'รับเงิน ร้านเก็บเงิน' })).not.toBeNull();
    expect(queueLoadCount).toBe(1);
    expect(paymentQueryCount).toBe(2);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(paymentQueryCount).toBe(4));
    expect(screen.queryByRole('dialog', { name: 'รับเงิน ร้านเก็บเงิน' })).toBeNull();
  });

  it('rejects payment evidence larger than 5 MB before recording', async () => {
    const user = userEvent.setup();
    const evidenceRequiredShop = {
      ...queueShop,
      payment_profile: {
        ...queueShop.payment_profile,
        cash_evidence_required: true,
      },
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [evidenceRequiredShop], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    const oversizedEvidence = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'evidence.jpg',
      { type: 'image/jpeg' },
    );
    await user.upload(screen.getByLabelText('หลักฐานการชำระ'), oversizedEvidence);

    expect((await screen.findByRole('alert')).textContent).toContain('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
    expect((screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.rpc).not.toHaveBeenCalledWith('record_payment', expect.anything());
  });

  it('keeps bank transfer and QR as distinct configured payment methods', async () => {
    const user = userEvent.setup();
    const allMethodsShop = {
      ...queueShop,
      payment_profile: {
        ...queueShop.payment_profile,
        allowed_payment_methods: ['cash', 'bank_transfer', 'qr'],
      },
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [allMethodsShop], error: null };
      if (name === 'record_payment') return {
        data: {
          payment_id: 'payment-bank',
          receipt_number: 'R260729-000002',
          allocated_amount: 100,
          change_amount: 0,
          recorded_at: '2026-07-29T07:00:00Z',
        },
        error: null,
      };
      if (name === 'get_payment_receipt_items') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    expect(screen.getByRole('button', { name: 'โอนเงิน' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'QR' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'โอนเงิน' }));
    const note = screen.getByRole('textbox', { name: 'หมายเหตุ' });
    expect(note.hasAttribute('required')).toBe(false);
    expect((screen.getByLabelText('หลักฐานการชำระ') as HTMLInputElement).required).toBe(true);
    await user.upload(screen.getByLabelText('หลักฐานการชำระ'), new File(['slip'], 'slip.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('checkbox', { name: 'พิมพ์ใบรับเงินหลังบันทึก' }));
    await user.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_payment', expect.objectContaining({
      p_payment_method: 'bank_transfer',
    })));
  });

  it('does not submit transfer evidence after switching back to cash', async () => {
    const user = userEvent.setup();
    const cashAndQrShop = {
      ...queueShop,
      payment_profile: {
        ...queueShop.payment_profile,
        allowed_payment_methods: ['cash', 'qr'],
      },
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [cashAndQrShop], error: null };
      if (name === 'record_payment') return {
        data: {
          payment_id: 'payment-cash',
          receipt_number: 'R260729-000003',
          allocated_amount: 100,
          change_amount: 0,
          recorded_at: '2026-07-29T07:00:00Z',
        },
        error: null,
      };
      if (name === 'get_payment_receipt_items') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    await user.click(screen.getByRole('button', { name: 'QR' }));
    await user.upload(screen.getByLabelText('หลักฐานการชำระ'), new File(['slip'], 'slip.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'เงินสด' }));
    await user.click(screen.getByRole('checkbox', { name: 'พิมพ์ใบรับเงินหลังบันทึก' }));
    await user.click(screen.getByRole('button', { name: 'บันทึกรับเงินทันที' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('record_payment', expect.objectContaining({
      p_payment_method: 'cash',
      p_evidence_path: null,
    })));
    expect(mocks.uploadPaymentEvidence).not.toHaveBeenCalled();
  });

  it('shows the message from a Supabase error object instead of object Object', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') {
        return queryResult(null, { message: 'ไม่พบคอลัมน์ receipt_number' });
      }
      return queryResult([]);
    });

    render(<FinancialOperations userRole="courier" />);

    expect((await screen.findByRole('alert')).textContent).toContain('ไม่พบคอลัมน์ receipt_number');
    expect(screen.getByRole('alert').textContent).not.toContain('[object Object]');
  });

  it('keeps keyboard focus inside the payment dialog and restores it when closed', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    const shopButton = await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ });
    await user.click(shopButton);

    const closeButton = await screen.findByRole('button', { name: 'ปิดหน้ารับเงิน' });
    const confirmButton = screen.getByRole('button', { name: 'บันทึกรับเงินทันที' });
    expect(document.activeElement).toBe(closeButton);
    expect(document.body.style.overflow).toBe('hidden');
    expect((document.querySelector('.financial-ops') as HTMLElement).inert).toBe(true);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirmButton);
    await user.tab();
    expect(document.activeElement).toBe(closeButton);

    await user.click(closeButton);
    await waitFor(() => expect(document.activeElement).toBe(shopButton));
    expect(document.body.style.overflow).toBe('');
    expect((document.querySelector('.financial-ops') as HTMLElement).inert).toBe(false);
  });

  it('opens a run with the selected collector assignment', async () => {
    const user = userEvent.setup();
    let runOpen = false;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(runOpen
        ? { id: 'run-1', opened_at: '2026-08-03T01:00:00.000Z' }
        : null);
      if (table === 'collection_run_members') return queryResult(runOpen ? [{ user_id: 'courier-1' }] : []);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: 'น้องหนึ่ง', avatar_path: null }],
        error: null,
      };
      if (name === 'open_collection_run') {
        runOpen = true;
        return { data: { collection_run_id: 'run-1' }, error: null };
      }
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    const openRunButton = await screen.findByRole('button', { name: /เปิดรอบและมอบหมาย/ });
    await user.click(openRunButton);
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    await waitFor(() => expect(document.activeElement).toBe(openRunButton));
    await user.click(openRunButton);
    await user.click(await screen.findByRole('checkbox', { name: /น้องหนึ่ง/ }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันเปิดรอบ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('open_collection_run', expect.objectContaining({
      p_member_ids: [{ user_id: 'courier-1' }],
    })));
    const closeRunButton = await screen.findByRole('button', { name: 'ปิดรอบเก็บเงิน' });
    expect(screen.getByText(/น้องหนึ่ง \(พนักงานหนึ่ง\)/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /S001 · ร้านเก็บเงิน/ })).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(closeRunButton));
    expect(screen.queryByRole('dialog', { name: 'เปิดรอบเก็บเงินท้ายวัน' })).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('get_collection_collectors');
    expect(mocks.from).not.toHaveBeenCalledWith('users');
  });

  it('keeps the assignment modal open when opening the run fails', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: null, avatar_path: null }],
        error: null,
      };
      if (name === 'open_collection_run') return { data: null, error: { message: 'เปิดรอบไม่สำเร็จ' } };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    await user.click(await screen.findByRole('button', { name: /เปิดรอบและมอบหมาย/ }));
    await user.click(await screen.findByRole('checkbox', { name: /พนักงานหนึ่ง/ }));
    await user.click(screen.getByRole('button', { name: 'ยืนยันเปิดรอบ' }));

    expect((await screen.findByRole('alert')).textContent).toContain('เปิดรอบไม่สำเร็จ');
    expect(screen.getByRole('dialog', { name: 'เปิดรอบเก็บเงินท้ายวัน' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ปิดรอบเก็บเงิน' })).toBeNull();
  });

  it('keeps active-run management available to managers without duplicating the shop queue', async () => {
    const user = userEvent.setup();
    let runOpen = true;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(runOpen
        ? { id: 'run-1', opened_at: '2026-08-03T01:00:00.000Z' }
        : null);
      if (table === 'collection_run_members') return queryResult(runOpen ? [{ user_id: 'courier-1' }] : []);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: null, avatar_path: null }],
        error: null,
      };
      if (name === 'close_collection_run') {
        runOpen = false;
        return { data: { status: 'closed' }, error: null };
      }
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);

    expect(await screen.findByText(/รอบปัจจุบัน:/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /S001 · ร้านเก็บเงิน/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'ปิดรอบเก็บเงิน' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('close_collection_run', {
      p_collection_run_id: 'run-1',
    }));
    expect(await screen.findByText('ยังไม่ได้เปิดรอบเก็บเงินประจำวัน')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /S001 · ร้านเก็บเงิน/ })).toBeNull();
  });

  it('does not offer a manager-only open-run action to couriers', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    render(<FinancialOperations userRole="courier" />);

    await screen.findByText('วันนี้ยังไม่มีรอบเก็บเงินที่มอบหมายให้คุณ');
    expect(screen.queryByRole('button', { name: 'เปิดรอบเก็บเงิน' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เปิดรอบและมอบหมาย' })).toBeNull();
  });

  it('loads payment records for the complete Bangkok business day', async () => {
    const dailyQuery = queryResult([]);
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') return dailyQuery;
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);

    await waitFor(() => expect(mocks.from).toHaveBeenCalledWith('payments'));
    expect(dailyQuery.gte).toHaveBeenCalledWith('recorded_at', expect.stringMatching(/T17:00:00\.000Z$/));
    expect(dailyQuery.lt).toHaveBeenCalledWith('recorded_at', expect.stringMatching(/T17:00:00\.000Z$/));
    expect(dailyQuery.limit).not.toHaveBeenCalled();
  });

  it('refreshes both courier totals and the selected payment-history day', async () => {
    const user = userEvent.setup();
    let paymentQueryCount = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') {
        paymentQueryCount += 1;
        return queryResult([]);
      }
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await waitFor(() => expect(paymentQueryCount).toBe(2));

    await user.click(screen.getByRole('button', { name: 'รีเฟรชยอดล่าสุด' }));
    await waitFor(() => expect(paymentQueryCount).toBe(4));
  });

  it('ignores an obsolete history error after the selected date changes', async () => {
    const user = userEvent.setup();
    const obsoleteHistory = deferredQueryResult();
    let paymentQueryCount = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') {
        paymentQueryCount += 1;
        return paymentQueryCount === 1 ? obsoleteHistory.query : queryResult([]);
      }
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: 'ประวัติรับเงิน' }));
    await user.click(await screen.findByRole('button', { name: '‹ วันก่อนหน้า' }));
    await waitFor(() => expect(paymentQueryCount).toBe(3));

    await act(async () => {
      obsoleteHistory.resolve({ data: null, error: { message: 'คำขอวันเดิมล้มเหลว' } });
      await Promise.resolve();
    });
    expect(screen.queryByText('คำขอวันเดิมล้มเหลว')).toBeNull();
  });

  it('shows a collector nickname and the configured profile photo', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: 'น้องหนึ่ง', avatar_path: 'courier-1/avatar.webp' }],
        error: null,
      };
      return { data: [], error: null };
    });
    mocks.createSignedUrls.mockResolvedValue({
      data: [{ path: 'courier-1/avatar.webp', signedUrl: 'https://cdn.example.test/courier-1/avatar.webp' }],
      error: null,
    });

    render(<FinancialOperations userRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: /เปิดรอบและมอบหมาย/ }));
    await screen.findByText(/น้องหนึ่ง/);
    await waitFor(() => expect(mocks.createSignedUrls).toHaveBeenCalledWith(['courier-1/avatar.webp'], 3600));
    expect(document.querySelector('img[src="https://cdn.example.test/courier-1/avatar.webp"]')).not.toBeNull();
  });

  it('keeps the collector fallback visible when avatar signing rejects', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: null, avatar_path: 'courier-1/avatar.webp' }],
        error: null,
      };
      return { data: [], error: null };
    });
    mocks.createSignedUrls.mockRejectedValue(new Error('storage unavailable'));

    render(<FinancialOperations userRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: /เปิดรอบและมอบหมาย/ }));
    await screen.findByText('พนักงานหนึ่ง');
    await waitFor(() => expect(mocks.createSignedUrls).toHaveBeenCalled());
    expect(document.querySelector('.financial-ops__collector-avatar img')).toBeNull();
    expect(document.querySelector('.financial-ops__collector-avatar svg')).not.toBeNull();
  });

  it('does not render a separate recent-payment history section', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    render(<FinancialOperations userRole="courier" />);

    await screen.findByText('รอบเก็บเงินท้ายวัน');
    expect(screen.queryByText('ประวัติรับเงินล่าสุด')).toBeNull();
  });

  it('shows one shop row and keeps bill status inside the shop detail drawer', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      if (name === 'get_credit_receivables') return { data: [{
        shop_id: 'shop-1', shop_code: 'S001', shop_name: 'ร้านเครดิต', credit_limit: null,
        available_credit_amount: null, outstanding_amount: 300, overdue_amount: 300,
        oldest_due_date: '2026-07-28', charges: [], payments: [],
      }], error: null };
      if (name === 'get_credit_receivable_detail') return { data: { charges: [{
          charge_id: 'credit-1', charge_number: 'C260728-000003', service_date: '2026-07-20',
          due_date: '2026-07-28', original_amount: 500, allocated_amount: 200,
          outstanding_amount: 300, days_overdue: 2, payment_status: 'partial', due_status: 'overdue',
          assigned_collection_run_id: null,
        }], payments: [] }, error: null };
      if (name === 'set_credit_charge_collection_assignment') return { data: { assigned: true }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations managerPage="credit" userRole="round_lead" />);
    await screen.findByRole('button', { name: 'S001 ร้านเครดิต' });
    expect(screen.queryByText('C260728-000003')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'S001 ร้านเครดิต' }));
    expect(await screen.findByRole('dialog', { name: 'รายละเอียดลูกหนี้ S001' })).not.toBeNull();
    expect(screen.getByText('C260728-000003')).not.toBeNull();
    expect(screen.getByText('ชำระบางส่วน · เกินกำหนด')).not.toBeNull();
    expect(screen.getAllByText('ไม่จำกัด').length).toBeGreaterThan(1);
  });

  it('loads one debtor detail on demand and opens collection on that store', async () => {
    const user = userEvent.setup();
    const targetQueueShop = {
      ...queueShop,
      shop_id: 'shop-2',
      shop_code: 'S002',
      shop_name: 'ร้านเป้าหมาย',
      charges: [{
        ...queueShop.charges[0],
        charge_id: 'credit-2',
        payment_term: 'credit' as const,
        due_date: '2026-08-04',
      }],
      charge_count: 1,
      outstanding_amount: 60,
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop, targetQueueShop], error: null };
      if (name === 'get_credit_receivables') return { data: [{
        shop_id: 'shop-2', shop_code: 'S002', shop_name: 'ร้านเป้าหมาย', credit_limit: 1_000,
        available_credit_amount: 940, outstanding_amount: 60, overdue_amount: 0,
        due_today_amount: 60, due_today_charge_count: 1, overdue_charge_count: 0,
        aging_current_amount: 60, aging_1_7_amount: 0, aging_8_15_amount: 0,
        aging_16_30_amount: 0, aging_over_30_amount: 0,
        oldest_due_date: '2026-08-04', charges: [], payments: [],
      }], error: null };
      if (name === 'get_credit_receivable_detail') return { data: {
        charges: [{
          charge_id: 'credit-2', charge_number: 'C260804-000002', service_date: '2026-08-01',
          due_date: '2026-08-04', original_amount: 60, allocated_amount: 0,
          outstanding_amount: 60, days_overdue: 0, payment_status: 'unpaid', due_status: 'due_today',
          assigned_collection_run_id: null,
        }],
        payments: [],
      }, error: null };
      return { data: [], error: null };
    });

    function Harness() {
      const [page, setPage] = useState<'collection' | 'credit'>('credit');
      return <FinancialOperations managerPage={page} onManagerPageChange={setPage} userRole="admin" />;
    }

    render(<Harness />);
    await screen.findByRole('button', { name: 'S002 ร้านเป้าหมาย' });
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_credit_receivable_detail', expect.anything());
    await user.click(screen.getByRole('button', { name: 'S002 ร้านเป้าหมาย' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_credit_receivable_detail', {
      p_as_of_date: expect.any(String),
      p_shop_id: 'shop-2',
    }));
    await user.click(await screen.findByRole('button', { name: 'บันทึกรับเงิน' }));
    expect(await screen.findByRole('dialog', { name: 'รับเงิน ร้านเป้าหมาย' })).not.toBeNull();
  });

  it('marks due bills automatic and only plans future bills explicitly', async () => {
    const user = userEvent.setup();
    const onToggleCreditCollectionAssignment = vi.fn();
    render(<ManagerFinancialSections
      approvals={[]}
      busy={false}
      dueDateRequests={[]}
      onDecide={() => undefined}
      onDecideDueDateRequest={() => undefined}
      onToggleCreditCollectionAssignment={onToggleCreditCollectionAssignment}
      receivables={[{
        shop_id: 'shop-1', shop_code: 'S001', shop_name: 'ร้านเครดิต', credit_limit: 1_000,
        available_credit_amount: 800, outstanding_amount: 200, overdue_amount: 100,
        oldest_due_date: '2026-08-01', charges: [
          {
            charge_id: 'due-charge', charge_number: 'C260801-000001', service_date: '2026-07-25',
            due_date: '2026-08-01', original_amount: 100, allocated_amount: 0,
            outstanding_amount: 100, days_overdue: 3, payment_status: 'unpaid', due_status: 'overdue',
            assigned_collection_run_id: null,
          },
          {
            charge_id: 'future-charge', charge_number: 'C260810-000002', service_date: '2026-08-03',
            due_date: '2026-08-10', original_amount: 100, allocated_amount: 0,
            outstanding_amount: 100, days_overdue: 0, payment_status: 'unpaid', due_status: 'not_due',
            assigned_collection_run_id: null,
          },
        ],
      }]}
      runId="run-1"
      serviceDate="2026-08-04"
    />);

    await user.click(screen.getByRole('button', { name: 'S001 ร้านเครดิต' }));
    expect(screen.getByText('เข้าเก็บอัตโนมัติ')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'เพิ่มเข้าแผนเก็บ' }));
    expect(onToggleCreditCollectionAssignment).toHaveBeenCalledWith(expect.objectContaining({ charge_id: 'future-charge' }), true);
  });

  it('shows aging buckets and overdue balances in the credit and receivables subpage', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
      if (name === 'get_credit_receivables') return { data: [{
        shop_id: 'shop-1', shop_code: 'S001', shop_name: 'ร้านเครดิต', credit_limit: 1_000,
        available_credit_amount: 700, outstanding_amount: 300, overdue_amount: 300,
        oldest_due_date: '2026-07-28', charges: [{
          charge_id: 'credit-1', charge_number: 'C260728-000003', service_date: '2026-07-20',
          due_date: '2026-07-28', original_amount: 300, allocated_amount: 0,
          outstanding_amount: 300, days_overdue: 31, payment_status: 'unpaid', due_status: 'overdue',
          assigned_collection_run_id: null,
        }],
      }], error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations managerPage="credit" userRole="round_lead" />);

    expect(await screen.findByRole('heading', { name: 'ลูกหนี้เครดิต' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Aging Report' }));

    expect(screen.getByRole('heading', { name: 'รายงานอายุลูกหนี้' })).not.toBeNull();
    expect(screen.getByText('เกิน 30 วัน')).not.toBeNull();
    expect(screen.getAllByText(/฿300\.00/).length).toBeGreaterThan(1);
    expect(screen.getByText(/ยอดค้างชำระเกินกำหนด/)).not.toBeNull();
  });

  it('includes due-today balances in aging and totals only defined available credit', async () => {
    const user = userEvent.setup();

    render(<ManagerFinancialSections
      approvals={[]}
      busy={false}
      dueDateRequests={[]}
      onDecide={() => undefined}
      onDecideDueDateRequest={() => undefined}
      onToggleCreditCollectionAssignment={() => undefined}
      receivables={[
        {
          shop_id: 'limited-shop', shop_code: 'L001', shop_name: 'ร้านมีวงเงิน', credit_limit: 1_000,
          available_credit_amount: 700, outstanding_amount: 300, overdue_amount: 0,
          oldest_due_date: '2026-08-04', charges: [{
            charge_id: 'due-today', charge_number: 'C260804-000001', service_date: '2026-08-01',
            due_date: '2026-08-04', original_amount: 300, allocated_amount: 0,
            outstanding_amount: 300, days_overdue: 0, payment_status: 'unpaid', due_status: 'due_today',
            assigned_collection_run_id: null,
          }],
        },
        {
          shop_id: 'unlimited-shop', shop_code: 'U001', shop_name: 'ร้านไม่จำกัดวงเงิน', credit_limit: null,
          available_credit_amount: null, outstanding_amount: 0, overdue_amount: 0,
          oldest_due_date: null, charges: [{
            charge_id: 'paid', charge_number: 'C260801-000002', service_date: '2026-08-01',
            due_date: '2026-08-03', original_amount: 200, allocated_amount: 200,
            outstanding_amount: 0, days_overdue: 1, payment_status: 'paid', due_status: 'paid',
            assigned_collection_run_id: null,
          }],
        },
      ]}
      runId="run-1"
    />);

    const limitedRow = screen.getByRole('row', { name: /L001 ร้านมีวงเงิน/ });
    expect(limitedRow.textContent).toContain('฿700.00');
    expect(limitedRow.textContent).not.toContain('ไม่จำกัด');

    await user.click(screen.getByRole('button', { name: 'Aging Report' }));
    const currentBucket = screen.getByText('ยังไม่ถึงกำหนด').closest('article');
    expect(currentBucket?.textContent).toContain('฿300.00');
    expect(currentBucket?.textContent).toContain('100%');
  });

  it('filters and sorts debtor summaries with their charge rows', async () => {
    const user = userEvent.setup();
    const { container } = render(<ManagerFinancialSections
      approvals={[]}
      busy={false}
      dueDateRequests={[]}
      onDecide={() => undefined}
      onDecideDueDateRequest={() => undefined}
      onToggleCreditCollectionAssignment={() => undefined}
      receivables={[
        {
          shop_id: 'current-shop', shop_code: 'C001', shop_name: 'ร้านยังไม่ถึงกำหนด', credit_limit: 1_000,
          available_credit_amount: 900, outstanding_amount: 100, overdue_amount: 0,
          oldest_due_date: '2026-08-10', charges: [{
            charge_id: 'current-charge', charge_number: 'C260810-000001', service_date: '2026-08-01',
            due_date: '2026-08-10', original_amount: 100, allocated_amount: 0,
            outstanding_amount: 100, days_overdue: 0, payment_status: 'unpaid', due_status: 'not_due',
            assigned_collection_run_id: null,
          }],
        },
        {
          shop_id: 'low-overdue-shop', shop_code: 'O001', shop_name: 'ร้านค้างน้อย', credit_limit: 1_000,
          available_credit_amount: 800, outstanding_amount: 200, overdue_amount: 200,
          oldest_due_date: '2026-08-01', charges: [{
            charge_id: 'low-overdue-charge', charge_number: 'C260801-000002', service_date: '2026-07-28',
            due_date: '2026-08-01', original_amount: 200, allocated_amount: 0,
            outstanding_amount: 200, days_overdue: 3, payment_status: 'unpaid', due_status: 'overdue',
            assigned_collection_run_id: null,
          }],
        },
        {
          shop_id: 'high-overdue-shop', shop_code: 'O002', shop_name: 'ร้านค้างมาก', credit_limit: 1_000,
          available_credit_amount: 400, outstanding_amount: 600, overdue_amount: 600,
          oldest_due_date: '2026-08-02', charges: [{
            charge_id: 'high-overdue-charge', charge_number: 'C260802-000003', service_date: '2026-07-29',
            due_date: '2026-08-02', original_amount: 600, allocated_amount: 0,
            outstanding_amount: 600, days_overdue: 2, payment_status: 'unpaid', due_status: 'overdue',
            assigned_collection_run_id: null,
          }],
        },
      ]}
      runId="run-1"
    />);

    await user.selectOptions(screen.getByLabelText('กรองสถานะการครบกำหนด'), 'overdue');
    expect(screen.queryByRole('button', { name: 'C001 ร้านยังไม่ถึงกำหนด' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('เรียงลูกหนี้'), 'outstanding');
    const debtorCodes = Array.from(container.querySelectorAll('.credit-ar__shop-link strong')).map((item) => item.textContent);
    expect(debtorCodes).toEqual(['O002', 'O001']);
  });

  it('lets an assigned collector request a due-date extension from a credit bill', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValueOnce('2026-08-15').mockReturnValueOnce('ร้านขอเลื่อนรอบรับเงิน');
    const creditQueueShop = {
      ...queueShop,
      charges: [{
        ...queueShop.charges[0],
        charge_id: 'credit-1',
        charge_number: 'C260728-000003',
        payment_term: 'credit',
        due_date: '2026-07-28',
      }],
      charge_count: 1,
      outstanding_amount: 60,
    };
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [creditQueueShop], error: null };
      if (name === 'request_credit_due_date_change') return { data: { id: 'due-request-1' }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านเก็บเงิน/ }));
    await user.click(screen.getByRole('button', { name: /ขอเลื่อนกำหนด/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('request_credit_due_date_change', {
      p_charge_id: 'credit-1',
      p_requested_due_date: '2026-08-15',
      p_reason: 'ร้านขอเลื่อนรอบรับเงิน',
    }));
  });
});

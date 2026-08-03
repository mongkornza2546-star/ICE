import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialOperations } from '../src/FinancialOperations';

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
  for (const method of ['select', 'eq', 'order', 'limit']) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn().mockResolvedValue(result);
  query.then = (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
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

  it('lets a courier reprint a persisted receipt from payment history', async () => {
    const user = userEvent.setup();
    const { printDocument, print } = mockReceiptPrintWindow();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') return queryResult([{
        id: 'payment-1',
        receipt_number: 'R260729-000001',
        received_amount: 100,
        allocated_amount: 100,
        change_amount: 0,
        payment_method: 'cash',
        status: 'active',
        recorded_at: '2026-07-29T07:00:00Z',
        void_reason: null,
        shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
      }]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [queueShop], error: null };
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
    await user.click(await screen.findByRole('button', { name: 'พิมพ์ซ้ำ' }));

    expect(printDocument.body.textContent).toContain('R260729-000001');
    expect(print).toHaveBeenCalledOnce();
  });

  it('opens the reprint window during the click before loading receipt details', async () => {
    const user = userEvent.setup();
    mockReceiptPrintWindow();
    let resolveReceiptItems!: (result: { data: unknown[]; error: null }) => void;
    const receiptItems = new Promise<{ data: unknown[]; error: null }>((resolve) => {
      resolveReceiptItems = resolve;
    });
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') return queryResult([{
        id: 'payment-1',
        receipt_number: 'R260729-000001',
        received_amount: 100,
        allocated_amount: 100,
        change_amount: 0,
        payment_method: 'cash',
        status: 'active',
        recorded_at: '2026-07-29T07:00:00Z',
        void_reason: null,
        shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
      }]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation((name: string) => {
      if (name === 'get_collection_run_queue') {
        return Promise.resolve({ data: [queueShop], error: null });
      }
      if (name === 'get_payment_receipt_items') return receiptItems;
      return Promise.resolve({ data: [], error: null });
    });

    render(<FinancialOperations userRole="courier" />);
    await user.click(await screen.findByRole('button', { name: 'พิมพ์ซ้ำ' }));

    expect(window.open).toHaveBeenCalledOnce();
    resolveReceiptItems({ data: [], error: null });
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
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'get_collection_collectors') return {
        data: [{ id: 'courier-1', code: 'C001', display_name: 'พนักงานหนึ่ง', nickname: 'น้องหนึ่ง', avatar_path: null }],
        error: null,
      };
      if (name === 'open_collection_run') return { data: { collection_run_id: 'run-1' }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    await user.click(await screen.findByRole('checkbox', { name: /น้องหนึ่ง/ }));
    await user.click(screen.getByRole('button', { name: 'เปิดรอบและมอบหมาย' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('open_collection_run', expect.objectContaining({
      p_member_ids: [{ user_id: 'courier-1' }],
    })));
    expect(mocks.rpc).toHaveBeenCalledWith('get_collection_collectors');
    expect(mocks.from).not.toHaveBeenCalledWith('users');
  });

  it('shows a collector nickname and the configured profile photo', async () => {
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

    const { container } = render(<FinancialOperations userRole="round_lead" />);

    await screen.findByText('น้องหนึ่ง');
    await waitFor(() => expect(mocks.createSignedUrls).toHaveBeenCalledWith(['courier-1/avatar.webp'], 3600));
    expect(container.querySelector('img[src="https://cdn.example.test/courier-1/avatar.webp"]')).not.toBeNull();
  });

  it('keeps the collector fallback visible when avatar signing rejects', async () => {
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

    const { container } = render(<FinancialOperations userRole="round_lead" />);

    await screen.findByText('พนักงานหนึ่ง');
    await waitFor(() => expect(mocks.createSignedUrls).toHaveBeenCalled());
    expect(container.querySelector('.financial-ops__collector-avatar img')).toBeNull();
    expect(container.querySelector('.financial-ops__collector-avatar svg')).not.toBeNull();
  });

  it('opens the paid bills from a recent payment entry', async () => {
    const user = userEvent.setup();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult({ id: 'run-1' });
      if (table === 'payments') return queryResult([{
        id: 'payment-1',
        receipt_number: 'R260729-000001',
        received_amount: 100,
        allocated_amount: 100,
        change_amount: 0,
        payment_method: 'cash',
        status: 'active',
        recorded_at: '2026-07-29T07:00:00Z',
        void_reason: null,
        shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
      }]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_collection_run_queue') return { data: [], error: null };
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
    await user.click(await screen.findByRole('button', { name: /ดูบิล R260729-000001/ }));

    expect(await screen.findByRole('dialog', { name: 'รายละเอียดใบเสร็จ R260729-000001' })).not.toBeNull();
    expect(screen.getByText('C260728-000001')).not.toBeNull();
    expect(screen.getByText('น้ำแข็งหลอด × 2 ถุง')).not.toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('get_payment_receipt_items', { p_payment_id: 'payment-1' });
  });

  it('lets a manager void an active payment from recent history', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('บันทึกยอดผิด');
    mocks.from.mockImplementation((table: string) => {
      if (table === 'collection_runs') return queryResult(null);
      if (table === 'payments') return queryResult([{
        id: 'payment-1',
        receipt_number: 'R260727-000001',
        received_amount: 100,
        allocated_amount: 100,
        change_amount: 0,
        payment_method: 'cash',
        status: 'active',
        recorded_at: '2026-07-27T08:00:00Z',
        void_reason: null,
        shops: { code: 'S001', name: 'ร้านเก็บเงิน' },
      }]);
      return queryResult([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_credit_receivables') return { data: [], error: null };
      if (name === 'void_payment') return { data: { payment_id: 'payment-1' }, error: null };
      return { data: [], error: null };
    });

    render(<FinancialOperations userRole="round_lead" />);
    await user.click(await screen.findByRole('button', { name: 'ยกเลิกรายการ' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('void_payment', {
      p_payment_id: 'payment-1',
      p_reason: 'บันทึกยอดผิด',
    }));
  });
});

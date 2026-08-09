import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingPage } from '../src/features/accounting/AccountingPage';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: rpcMock },
}));

function bangkokDate(daysFromToday = 0) {
  const date = new Date(Date.now() + 7 * 60 * 60 * 1_000);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

const historyServiceDate = bangkokDate(-2);

const populatedSummary = {
  rows: [{
    shop_id: 'shop-1',
    shop_code: 'S001',
    shop_name: 'ร้านสมใจ',
    building_id: 'building-1',
    building_name: 'อาคาร A',
    current_zone_id: 'zone-current',
    current_zone_name: 'ชั้น 9 ปัจจุบัน',
    historical_zone_name: 'ชั้น 1 ตอนส่ง',
    payment_term: 'end_of_day',
    employee_names: 'พนักงานหนึ่ง',
    sales_amount: 1_250,
    paid_amount: 900,
    outstanding_amount: 350,
    overdue_amount: 0,
    invoice_count: 2,
    due_date: bangkokDate(),
    cumulative_outstanding_amount: 750,
    cumulative_overdue_amount: 400,
    oldest_outstanding_due_date: bangkokDate(-3),
    payment_status: 'overdue',
  }],
  total_count: 1,
  totals: {
    sales_amount: 1_250,
    paid_amount: 900,
    outstanding_amount: 350,
    overdue_amount: 0,
    outstanding_shop_count: 1,
    cumulative_outstanding_amount: 750,
    cumulative_overdue_amount: 400,
    cumulative_outstanding_shop_count: 1,
    cash_received_in_period: 1_100,
  },
  facets: {
    shops: [{ value: 'shop-1', label: 'S001 · ร้านสมใจ', count: 1 }],
    buildings: [{ value: 'building-1', label: 'อาคาร A', count: 1 }],
    zones: [{ value: 'zone-current', label: 'อาคาร A / ชั้น 9 ปัจจุบัน', count: 1 }],
  },
};

const purchaseHistory = [{
  delivery_event_id: 'delivery-1',
  charge_id: 'charge-1',
  charge_number: 'INV2608-00001',
  service_date: historyServiceDate,
  recorded_at: `${historyServiceDate}T09:30:00+07:00`,
  recorded_by_name: 'พนักงานหนึ่ง',
  total_amount: 500,
  payment_term: 'end_of_day',
  allocated_amount: 300,
  outstanding_amount: 200,
  payment_status: 'partial',
  building_id: 'building-old',
  building_name: 'อาคารเดิม',
  historical_zone_name: 'ชั้น 1 ตอนส่ง',
  current_zone_id: 'zone-current',
  current_zone_name: 'ชั้น 9 ปัจจุบัน',
  items: [{ ice_type_id: 'ice-1', name: 'น้ำแข็งหลอด', unit: 'ถุง', quantity: 10, unit_price: 50, line_total: 500 }],
  payments: [{ payment_id: 'payment-1', payment_method: 'cash', amount: 300, recorded_at: `${historyServiceDate}T18:00:00+07:00` }],
  adjustments: [],
}];

function mockSuccessfulShopSummary() {
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
    if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 2 }, error: null };
    if (name === 'get_accounting_shop_invoice_detail') return { data: purchaseHistory, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe('accounting shop summary', () => {
  it('opens as the default accounting view with business-level KPIs', async () => {
    render(<AccountingPage demoMode />);

    const summaryTab = screen.getByRole('button', { name: 'สรุปรายร้าน' });
    expect(summaryTab.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('ยอดขายช่วงนี้', { selector: 'article span' })).toBeTruthy();
    expect(screen.getByText('รับแล้วของยอดขายช่วงนี้', { selector: 'article span' })).toBeTruthy();
    expect(screen.getByText('ค้างสะสมทั้งหมด', { selector: 'article span' })).toBeTruthy();
    expect(screen.getByText('เกินกำหนดสะสม', { selector: 'article span' })).toBeTruthy();
    expect(screen.getByText('เงินรับจริงช่วงนี้', { selector: 'article span' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'ร้าน' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'ค้างช่วงนี้' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'ค้างสะสม' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'สถานะชำระ' })).toBeTruthy();
  });

  it('keeps the raw ledger available as a separate view', async () => {
    const user = userEvent.setup();
    render(<AccountingPage demoMode />);

    await user.click(screen.getByRole('button', { name: 'รายการแบบ Excel' }));

    expect(screen.getByRole('button', { name: 'รายการแบบ Excel' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByPlaceholderText('เลขเอกสาร / อ้างอิง')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /ประเภท/ })).toBeTruthy();
  });

  it('renders an active shop with no period sales and its cumulative old debt', async () => {
    const oldDebtInvoice = {
      ...purchaseHistory[0],
      delivery_event_id: 'delivery-old-debt',
      charge_id: 'charge-old-debt',
      charge_number: 'INV-OLD-DEBT',
      service_date: bangkokDate(-30),
      recorded_at: `${bangkokDate(-30)}T09:30:00+07:00`,
      total_amount: 200,
      allocated_amount: 0,
      outstanding_amount: 200,
      payments: [],
      payment_status: 'unpaid' as const,
    };
    const zeroSalesShop = {
      ...populatedSummary.rows[0],
      shop_id: 'shop-2',
      shop_code: 'S002',
      shop_name: 'ร้านไม่มีรายการวันนี้',
      payment_term: null,
      employee_names: null,
      sales_amount: 0,
      paid_amount: 0,
      outstanding_amount: 0,
      overdue_amount: 0,
      invoice_count: 0,
      due_date: null,
      cumulative_outstanding_amount: 200,
      cumulative_overdue_amount: 125,
      oldest_outstanding_due_date: bangkokDate(-10),
      payment_status: 'overdue',
    } as const;
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_accounting_shop_summary') {
        return { data: { ...populatedSummary, rows: [populatedSummary.rows[0], zeroSalesShop], total_count: 2 }, error: null };
      }
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      if (name === 'get_accounting_shop_invoice_detail') return { data: [oldDebtInvoice], error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const user = userEvent.setup();
    render(<AccountingPage />);

    const shopButton = await screen.findByRole('button', { name: /S002 · ร้านไม่มีรายการวันนี้/ });
    const row = shopButton.closest('tr');
    expect(row).toBeTruthy();
    const cells = row!.querySelectorAll('td');
    expect(cells[2].textContent).toMatch(/฿0\.00/);
    expect(cells[3].textContent).toMatch(/฿0\.00/);
    expect(cells[4].textContent).toMatch(/฿0\.00/);
    expect(cells[5].textContent).toMatch(/฿200\.00/);
    expect(cells[6].textContent).toMatch(/฿125\.00/);
    expect(cells[7].textContent).toBe('0');
    expect(within(row as HTMLTableRowElement).getByText('เกินกำหนด')).toBeTruthy();
    expect(screen.queryByText('ไม่ซื้อ')).toBeNull();

    await user.click(shopButton);

    const detail = await screen.findByRole('dialog', { name: 'รายละเอียดบิลของ S002 · ร้านไม่มีรายการวันนี้' });
    expect(within(detail).getByText('INV-OLD-DEBT')).toBeTruthy();
    expect(within(detail).getByText('หนี้ค้างก่อนช่วง')).toBeTruthy();
  });

  it('opens invoice-centric detail for the selected shop and summary period', async () => {
    const user = userEvent.setup();
    mockSuccessfulShopSummary();
    render(<AccountingPage />);

    await user.click(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ }));

    const fromDate = (screen.getByLabelText('จาก') as HTMLInputElement).value;
    const toDate = (screen.getByLabelText('ถึง') as HTMLInputElement).value;
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_invoice_detail', {
      p_shop_id: 'shop-1',
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: {},
      p_limit: 100,
      p_offset: 0,
    }));
    const detail = await screen.findByRole('dialog', { name: 'รายละเอียดบิลของ S001 · ร้านสมใจ' });
    expect(detail.getAttribute('aria-modal')).toBe('true');
    expect(within(detail).getByText(/ช่วงสรุปและบิลค้างนอกช่วง/)).toBeTruthy();
    expect(within(detail).getByText(/ยอดรับแล้วและยอดค้างเป็นยอดปัจจุบัน/)).toBeTruthy();
    expect(within(detail).getByText('INV2608-00001')).toBeTruthy();
    expect(within(detail).getByText(/น้ำแข็งหลอด/)).toBeTruthy();
    expect(within(detail).getByText(/เงินสด.*300\.00/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'สรุปรายร้าน' }).getAttribute('aria-current')).toBe('page');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'รายละเอียดบิลของ S001 · ร้านสมใจ' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('renders payment dates in Bangkok time regardless of the browser timezone', async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    const recordedAt = '2026-08-03T00:30:00+07:00';
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      if (name === 'get_accounting_shop_invoice_detail') {
        return { data: [{ ...purchaseHistory[0], payments: [{ ...purchaseHistory[0].payments[0], recorded_at: recordedAt }] }], error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    try {
      const user = userEvent.setup();
      render(<AccountingPage />);
      await user.click(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ }));

      const detail = await screen.findByRole('dialog', { name: 'รายละเอียดบิลของ S001 · ร้านสมใจ' });
      const bangkokDateLabel = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok' }).format(new Date(recordedAt));
      expect(detail.querySelector('.accounting-shop-detail__payments')?.textContent).toContain(bangkokDateLabel);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('keeps a successful shop summary when the review badge fails', async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_review_queue') return { data: null, error: { message: 'โหลดจำนวนตรวจสอบไม่ได้' } };
      throw new Error(`Unexpected RPC: ${name}`);
    });

    render(<AccountingPage />);

    expect(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const reviewCard = screen.getByText('รายการต้องตรวจสอบ', { selector: 'article span' }).closest('article');
    expect(reviewCard && within(reviewCard).getByText('—')).toBeTruthy();
  });

  it('clears stale shop rows and KPIs when a filtered summary request fails', async () => {
    let summaryRequests = 0;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_shop_summary') {
        summaryRequests += 1;
        return summaryRequests === 1
          ? { data: populatedSummary, error: null }
          : { data: null, error: { message: 'โหลดสรุปตามตัวกรองไม่สำเร็จ' } };
      }
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);
    expect(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeTruthy();

    await user.selectOptions(screen.getByRole('combobox', { name: 'สถานะชำระ' }), 'paid');

    expect((await screen.findByRole('alert')).textContent).toContain('โหลดสรุปตามตัวกรองไม่สำเร็จ');
    expect(screen.queryByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeNull();
    expect(screen.queryAllByText(/1,250\.00/)).toHaveLength(0);
  });

  it('renders populated results and sends shop filters and pagination to the summary RPC', async () => {
    const pagedSummary = { ...populatedSummary, total_count: 101 };
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_shop_summary') return { data: pagedSummary, error: null };
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 2 }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);

    expect(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeTruthy();
    const fromDate = (screen.getByLabelText('จาก') as HTMLInputElement).value;
    const toDate = (screen.getByLabelText('ถึง') as HTMLInputElement).value;
    expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_summary', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: {},
      p_limit: 100,
      p_offset: 0,
    });
    expect(screen.getAllByText(/1,250\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText('1 / 2')).toBeTruthy();

    await user.selectOptions(screen.getByRole('combobox', { name: 'อาคาร' }), 'building-1');
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_summary', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: { building_id: 'building-1', zone_id: undefined },
      p_limit: 100,
      p_offset: 0,
    }));
    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'เงื่อนไขชำระ' }), 'credit');
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_summary', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: { building_id: 'building-1', zone_id: undefined, payment_term: 'credit' },
      p_limit: 100,
      p_offset: 0,
    }));
    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });

    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_summary', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: { building_id: 'building-1', zone_id: undefined, payment_term: 'credit' },
      p_limit: 100,
      p_offset: 100,
    }));
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });

  it('returns to the last available page when refreshed results shrink', async () => {
    let resultsShrank = false;
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      if (name === 'get_accounting_shop_summary') {
        if (args.p_offset === 100) {
          resultsShrank = true;
          return { data: { ...populatedSummary, rows: [], total_count: 100 }, error: null };
        }
        return { data: { ...populatedSummary, total_count: resultsShrank ? 100 : 101 }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);

    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_summary', expect.objectContaining({ p_offset: 100 })));
    expect(await screen.findByText('1 / 1')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeTruthy();
  });

  it('clears the prior summary when the selected date range fails validation', async () => {
    mockSuccessfulShopSummary();
    render(<AccountingPage />);
    expect(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('จาก'), { target: { value: bangkokDate(-40) } });

    expect((await screen.findByRole('alert')).textContent).toContain('ดูข้อมูลได้สูงสุด 31 วันต่อครั้ง');
    expect(screen.queryByRole('button', { name: /S001 · ร้านสมใจ/ })).toBeNull();
    expect(screen.queryAllByText(/1,250\.00/)).toHaveLength(0);
    expect(rpcMock.mock.calls.filter(([name]) => name === 'get_accounting_shop_summary')).toHaveLength(1);
  });

  it('pages filtered invoice detail until the server returns a short page', async () => {
    const firstHistoryPage = Array.from({ length: 100 }, (_, index) => ({
      ...purchaseHistory[0],
      delivery_event_id: `delivery-page-1-${index}`,
      charge_number: `INV-PAGE-1-${index}`,
      service_date: bangkokDate(-1),
      recorded_at: `${bangkokDate(-1)}T09:30:00+07:00`,
      payments: [],
    }));
    const secondHistoryPage = [{
      ...purchaseHistory[0],
      delivery_event_id: 'delivery-page-2',
      charge_number: 'INV-PAGE-2',
      service_date: bangkokDate(-6),
      recorded_at: `${bangkokDate(-6)}T09:30:00+07:00`,
      payments: [],
    }];
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      if (name === 'get_accounting_shop_invoice_detail') {
        return { data: args.p_offset === 0 ? firstHistoryPage : secondHistoryPage, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);
    const fromDate = (screen.getByLabelText('จาก') as HTMLInputElement).value;
    const toDate = (screen.getByLabelText('ถึง') as HTMLInputElement).value;

    await user.click(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ }));

    expect(await screen.findByText('INV-PAGE-2')).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_invoice_detail', {
      p_shop_id: 'shop-1',
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: {},
      p_limit: 100,
      p_offset: 100,
    });
  });

  it('does not apply current-profile or location filters to invoice history', async () => {
    const cohortInvoice = {
      ...purchaseHistory[0],
      charge_number: 'INV-CREDIT-BUILDING-1',
      payment_term: 'credit',
      building_id: 'building-1',
      building_name: 'อาคารเดิม A',
      historical_zone_name: 'โซนเดิม 1',
    };
    const outOfCohortInvoice = {
      ...purchaseHistory[0],
      delivery_event_id: 'delivery-other-cohort',
      charge_number: 'INV-IMMEDIATE-BUILDING-2',
      payment_term: 'immediate',
      building_id: 'building-2',
      building_name: 'อาคารเดิม B',
      historical_zone_name: 'โซนเดิม 2',
    };
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      if (name === 'get_accounting_shop_invoice_detail') {
        return { data: [cohortInvoice, outOfCohortInvoice], error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);
    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });
    const fromDate = (screen.getByLabelText('จาก') as HTMLInputElement).value;
    const toDate = (screen.getByLabelText('ถึง') as HTMLInputElement).value;

    await user.selectOptions(screen.getByRole('combobox', { name: 'อาคาร' }), 'building-1');
    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'โซน' }), 'zone-current');
    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'เงื่อนไขชำระ' }), 'credit');
    await user.click(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_shop_invoice_detail', {
      p_shop_id: 'shop-1',
      p_from_date: fromDate,
      p_to_date: toDate,
      p_filters: {},
      p_limit: 100,
      p_offset: 0,
    }));
    expect(await screen.findByText('INV-CREDIT-BUILDING-1')).toBeTruthy();
    expect(screen.getByText('INV-IMMEDIATE-BUILDING-2')).toBeTruthy();
    expect(screen.getByText('อาคารเดิม A / โซนเดิม 1')).toBeTruthy();
    expect(screen.getByText('อาคารเดิม B / โซนเดิม 2')).toBeTruthy();
  });

  it('shows invoice adjustment amounts and corrected item quantities', async () => {
    const adjustedInvoice = {
      ...purchaseHistory[0],
      adjustments: [{
        id: 'adjustment-1',
        scope: 'items',
        amount_delta: -100,
        corrected_total: 400,
        reason: 'แก้จำนวนส่งผิด',
        created_at: `${historyServiceDate}T12:00:00+07:00`,
        items: [{
          ice_type_id: 'ice-1',
          name: 'น้ำแข็งหลอด',
          unit: 'ถุง',
          original_quantity: 10,
          corrected_quantity: 8,
          quantity_delta: -2,
        }, {
          ice_type_id: 'ice-2',
          name: 'น้ำแข็งก้อน',
          unit: 'ถุง',
          original_quantity: 0,
          corrected_quantity: 2,
          quantity_delta: 2,
        }],
      }],
    };
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
      if (name === 'get_accounting_shop_invoice_detail') return { data: [adjustedInvoice], error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);

    await user.click(await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ }));

    const detail = await screen.findByRole('dialog', { name: 'รายละเอียดบิลของ S001 · ร้านสมใจ' });
    expect(within(detail).getByText(/น้ำแข็งหลอด 10 ถุง/, { selector: 'strong' })).toBeTruthy();
    expect(within(detail).getByText(/แก้เป็น 8 ถุง/)).toBeTruthy();
    expect(within(detail).getByText(/น้ำแข็งก้อน.*แก้เป็น 2 ถุง/)).toBeTruthy();
    expect(within(detail).getByText('แก้จำนวนส่งผิด')).toBeTruthy();
    expect(within(detail).getByText(/ยอดปรับ.*100\.00/)).toBeTruthy();
    expect(within(detail).getByText(/ยอดหลังปรับ.*400\.00/)).toBeTruthy();
  });

  it('does not let a late shop badge response overwrite the review-tab count', async () => {
    type BadgeResponse = { data: { rows: never[]; total_count: number }; error: null };
    let resolveBadge: (response: BadgeResponse) => void = () => undefined;
    const badgeRequest = new Promise<BadgeResponse>((resolve) => { resolveBadge = resolve; });
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_review_queue' && args.p_limit === 1) return badgeRequest;
      if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 7 }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);
    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });

    await user.click(screen.getByRole('button', { name: 'รายการต้องตรวจสอบ' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ/ }).textContent).toContain('7'));

    await act(async () => {
      resolveBadge({ data: { rows: [], total_count: 99 }, error: null });
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ/ }).textContent).toContain('7');
    expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ/ }).textContent).not.toContain('99');
  });

  it('refreshes the review badge when the shared date range changes on the transaction tab', async () => {
    const initialFromDate = bangkokDate(-6);
    const nextFromDate = bangkokDate(-5);
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_accounting_shop_summary') return { data: populatedSummary, error: null };
      if (name === 'get_accounting_transactions') {
        return { data: { rows: [], total_count: 0, facets: { ice_types: [], shops: [], employees: [], types: [] } }, error: null };
      }
      if (name === 'get_accounting_review_queue') {
        return { data: { rows: [], total_count: args.p_from_date === nextFromDate ? 5 : 2 }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const user = userEvent.setup();
    render(<AccountingPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ/ }).textContent).toContain('2'));
    expect((screen.getByLabelText('จาก') as HTMLInputElement).value).toBe(initialFromDate);
    await user.click(screen.getByRole('button', { name: 'รายการแบบ Excel' }));
    fireEvent.change(screen.getByLabelText('จาก'), { target: { value: nextFromDate } });

    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_accounting_review_queue', {
      p_from_date: nextFromDate,
      p_to_date: bangkokDate(),
      p_filters: {},
      p_limit: 1,
      p_offset: 0,
    }));
    expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ/ }).textContent).toContain('5');
  });

  it('shows the current shop location in both the row and filter facet', async () => {
    mockSuccessfulShopSummary();
    render(<AccountingPage />);

    await screen.findByRole('button', { name: /S001 · ร้านสมใจ/ });

    expect(screen.getByText('อาคาร A / ชั้น 9 ปัจจุบัน')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'อาคาร A / ชั้น 9 ปัจจุบัน (1)' })).toBeTruthy();
  });
});

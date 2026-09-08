import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PaymentHistorySection } from '../src/features/financial-operations/components/FinancialOperationsPanels';
import type { PaymentHistoryItem } from '../src/features/financial-operations/types';

const historyItems: PaymentHistoryItem[] = [
  {
    id: 'pay-1',
    receipt_number: 'RC-001',
    received_amount: 100,
    allocated_amount: 100,
    change_amount: 0,
    payment_method: 'cash',
    status: 'active',
    recorded_at: '2026-07-31T08:30:00.000Z',
    void_reason: null,
    building_id: 'b-a',
    building_name: 'อาคาร A',
    zone_id: 'z-a1',
    zone_name: 'โซน 1',
    image_path: 'shops/a1.jpg',
    image_url: 'https://cdn.example.com/a1.jpg',
    shops: { code: 'A1', name: 'ร้านก๋วยเตี๋ยว A' },
  },
  {
    id: 'pay-2',
    receipt_number: 'RC-002',
    received_amount: 200,
    allocated_amount: 200,
    change_amount: 0,
    payment_method: 'bank_transfer',
    status: 'active',
    recorded_at: '2026-07-31T09:00:00.000Z',
    void_reason: null,
    building_id: 'b-a',
    building_name: 'อาคาร A',
    zone_id: 'z-a2',
    zone_name: 'โซน 2',
    image_path: null,
    image_url: null,
    shops: { code: 'A2', name: 'ร้านกาแฟ A' },
  },
  {
    id: 'pay-3',
    receipt_number: 'RC-003',
    received_amount: 300,
    allocated_amount: 300,
    change_amount: 0,
    payment_method: 'cash',
    status: 'active',
    recorded_at: '2026-07-31T09:30:00.000Z',
    void_reason: null,
    building_id: 'b-b',
    building_name: 'อาคาร B',
    zone_id: 'z-b1',
    zone_name: 'โซน 1',
    image_path: null,
    image_url: null,
    shops: { code: 'B1', name: 'ร้านข้าวมันไก่ B' },
  },
  {
    id: 'pay-4',
    receipt_number: 'RC-EV01',
    received_amount: 500,
    allocated_amount: 500,
    change_amount: 0,
    payment_method: 'cash',
    status: 'active',
    recorded_at: '2026-07-31T10:00:00.000Z',
    void_reason: null,
    destination_kind: 'event',
    building_id: null,
    building_name: 'ฮอลล์ 1',
    zone_id: null,
    zone_name: 'โซนอีเวนต์',
    event_name: 'งานแสดงสินค้าฤดูร้อน',
    event_location: 'ฮอลล์ 1',
    event_zone: 'โซนอีเวนต์',
    event_booth: 'EV-88',
    image_path: null,
    image_url: 'https://cdn.example.com/ev88.jpg',
    shops: { code: 'EV-88', name: 'ร้านอีเวนต์พิเศษ' },
  },
  // Older payload without location or image fields
  {
    id: 'pay-legacy',
    receipt_number: 'RC-LEGACY',
    received_amount: 50,
    allocated_amount: 50,
    change_amount: 0,
    payment_method: 'cash',
    status: 'active',
    recorded_at: '2026-07-31T10:30:00.000Z',
    void_reason: null,
    shops: { code: 'LEG1', name: 'ร้านดั้งเดิม' },
  },
];

describe('PaymentHistorySection filters and photos', () => {
  it('renders shop thumbnails, placeholders, and legacy payloads gracefully', () => {
    const { container } = render(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={false}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={vi.fn()}
        onPrintReceipt={vi.fn()}
        onVoidPayment={vi.fn()}
        paymentHistory={historyItems}
        serviceDate="2026-07-31"
      />,
    );

    // Image rendered for pay-1
    const imgA1 = container.querySelector('.financial-ops__history-visual img');
    expect(imgA1).toBeTruthy();
    expect(imgA1?.getAttribute('src')).toBe('https://cdn.example.com/a1.jpg');

    // Scope note rendered
    expect(screen.getByText('ตัวกรองตึก/โซนใช้กับร้านประจำ · ค้นหางานอีเวนต์ได้จากช่องค้นหา')).toBeTruthy();

    // All items initially visible
    expect(screen.getByText(/ร้านก๋วยเตี๋ยว A/)).toBeTruthy();
    expect(screen.getByText(/ร้านกาแฟ A/)).toBeTruthy();
    expect(screen.getByText(/ร้านข้าวมันไก่ B/)).toBeTruthy();
    expect(screen.getByText(/ร้านอีเวนต์พิเศษ/)).toBeTruthy();
    expect(screen.getByText(/ร้านดั้งเดิม/)).toBeTruthy();
  });

  it('filters by building and zone, including dependent zone options and event exclusion', async () => {
    const user = userEvent.setup();
    render(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={false}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={vi.fn()}
        onPrintReceipt={vi.fn()}
        onVoidPayment={vi.fn()}
        paymentHistory={historyItems}
        serviceDate="2026-07-31"
      />,
    );

    const buildingSelect = screen.getByLabelText('เลือกตึก') as HTMLSelectElement;
    const zoneSelect = screen.getByLabelText('เลือกโซน') as HTMLSelectElement;

    // Zone select should be disabled initially
    expect(zoneSelect.disabled).toBe(true);

    // Select "อาคาร A"
    await user.selectOptions(buildingSelect, 'b-a');
    expect(zoneSelect.disabled).toBe(false);

    // Only Building A regular shops should be visible; B, event, legacy excluded
    expect(screen.getByText(/ร้านก๋วยเตี๋ยว A/)).toBeTruthy();
    expect(screen.getByText(/ร้านกาแฟ A/)).toBeTruthy();
    expect(screen.queryByText(/ร้านข้าวมันไก่ B/)).toBeNull();
    expect(screen.queryByText(/ร้านอีเวนต์พิเศษ/)).toBeNull();
    expect(screen.queryByText(/ร้านดั้งเดิม/)).toBeNull();

    // Select "โซน 2" in อาคาร A
    await user.selectOptions(zoneSelect, 'z-a2');
    expect(screen.queryByText(/ร้านก๋วยเตี๋ยว A/)).toBeNull();
    expect(screen.getByText(/ร้านกาแฟ A/)).toBeTruthy();

    // Change building to "อาคาร B" -> zone should reset and show B1
    await user.selectOptions(buildingSelect, 'b-b');
    expect(screen.getByText(/ร้านข้าวมันไก่ B/)).toBeTruthy();
    expect(screen.queryByText(/ร้านกาแฟ A/)).toBeNull();
    expect(zoneSelect.value).toBe('');

    // Reset building to "ทุกตึก" -> event and legacy shops reappear
    await user.selectOptions(buildingSelect, '');
    expect(screen.getByText(/ร้านอีเวนต์พิเศษ/)).toBeTruthy();
    expect(screen.getByText(/ร้านดั้งเดิม/)).toBeTruthy();
  });

  it('searches across shop code, name, receipt number, and event snapshot fields', async () => {
    const user = userEvent.setup();
    render(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={false}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={vi.fn()}
        onPrintReceipt={vi.fn()}
        onVoidPayment={vi.fn()}
        paymentHistory={historyItems}
        serviceDate="2026-07-31"
      />,
    );

    const searchInput = screen.getByLabelText('ค้นหาร้านค้าหรือบิล');

    // Search by receipt number
    await user.type(searchInput, 'RC-002');
    expect(screen.getByText(/ร้านกาแฟ A/)).toBeTruthy();
    expect(screen.queryByText(/ร้านก๋วยเตี๋ยว A/)).toBeNull();

    // Clear and search by event booth
    await user.clear(searchInput);
    await user.type(searchInput, 'EV-88');
    expect(screen.getByText(/ร้านอีเวนต์พิเศษ/)).toBeTruthy();
    expect(screen.queryByText(/ร้านกาแฟ A/)).toBeNull();

    // Search with no results: filters remain accessible, show "ไม่พบรายการตามตัวกรอง"
    await user.clear(searchInput);
    await user.type(searchInput, 'xyz-nonexistent');
    expect(screen.getByText('ไม่พบรายการตามตัวกรอง')).toBeTruthy();
    expect(screen.getByLabelText('ค้นหาร้านค้าหรือบิล')).toBeTruthy();
    expect(screen.getByLabelText('เลือกตึก')).toBeTruthy();

    // Clear restores rows
    await user.clear(searchInput);
    expect(screen.getByText(/ร้านก๋วยเตี๋ยว A/)).toBeTruthy();
  });

  it('triggers onOpenReceipt, onPrintReceipt, and onVoidPayment with correct payment item', async () => {
    const user = userEvent.setup();
    const handleOpen = vi.fn();
    const handlePrint = vi.fn();
    const handleVoid = vi.fn();

    render(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={true}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={handleOpen}
        onPrintReceipt={handlePrint}
        onVoidPayment={handleVoid}
        paymentHistory={historyItems}
        serviceDate="2026-07-31"
      />,
    );

    // Click on summary button to open receipt
    const openBtn = screen.getByLabelText('ดูบิล RC-001 ของ ร้านก๋วยเตี๋ยว A');
    await user.click(openBtn);
    expect(handleOpen).toHaveBeenCalledWith(historyItems[0], expect.anything());

    // Click print duplicate
    const printButtons = screen.getAllByRole('button', { name: /พิมพ์ซ้ำ/ });
    await user.click(printButtons[0]);
    expect(handlePrint).toHaveBeenCalledWith(historyItems[0]);

    // Click void payment
    const voidButtons = screen.getAllByRole('button', { name: /ยกเลิกรายการ/ });
    await user.click(voidButtons[0]);
    expect(handleVoid).toHaveBeenCalledWith(historyItems[0]);
  });

  it('resets query/building/zone on parent date change via key={historyDate}', async () => {
    const user = userEvent.setup();

    function ParentHarness() {
      const [date, setDate] = useState('2026-07-31');
      const itemsForDate = date === '2026-07-31' ? historyItems : [
        {
          id: 'pay-b2',
          receipt_number: 'RC-B2',
          received_amount: 50,
          allocated_amount: 50,
          change_amount: 0,
          payment_method: 'cash' as const,
          status: 'active' as const,
          recorded_at: '2026-07-30T09:00:00.000Z',
          void_reason: null,
          building_id: 'b-c',
          building_name: 'อาคาร C',
          zone_id: 'z-c1',
          zone_name: 'โซน 1',
          image_path: null,
          image_url: null,
          shops: { code: 'C1', name: 'ร้านซีวัน' },
        },
      ];

      return (
        <div>
          <button onClick={() => setDate('2026-07-30')} type="button">เปลี่ยนเป็น 30</button>
          <PaymentHistorySection
            key={date}
            busy={false}
            currentUserId="user-1"
            historyDate={date}
            isManager={false}
            onHistoryDateChange={setDate}
            onOpenReceipt={vi.fn()}
            onPrintReceipt={vi.fn()}
            onVoidPayment={vi.fn()}
            paymentHistory={itemsForDate}
            serviceDate="2026-07-31"
          />
        </div>
      );
    }

    render(<ParentHarness />);

    // Select Building A on 2026-07-31
    const buildingSelect = screen.getByLabelText('เลือกตึก') as HTMLSelectElement;
    await user.selectOptions(buildingSelect, 'b-a');
    expect(screen.getByText(/ร้านก๋วยเตี๋ยว A/)).toBeTruthy();

    // Change date to 2026-07-30 which only has Building C
    await user.click(screen.getByText('เปลี่ยนเป็น 30'));

    // Building should be reset, Building C shop should be visible
    expect(screen.getByText(/ร้านซีวัน/)).toBeTruthy();
    const newBuildingSelect = screen.getByLabelText('เลือกตึก') as HTMLSelectElement;
    expect(newBuildingSelect.value).toBe('');
  });

  it('clears missing location state on same-date refresh so it cannot reactivate later', async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={false}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={vi.fn()}
        onPrintReceipt={vi.fn()}
        onVoidPayment={vi.fn()}
        paymentHistory={historyItems}
        serviceDate="2026-07-31"
      />,
    );

    // Select Building A / Zone 2
    const buildingSelect = screen.getByLabelText('เลือกตึก') as HTMLSelectElement;
    await user.selectOptions(buildingSelect, 'b-a');
    await user.selectOptions(screen.getByLabelText('เลือกโซน'), 'z-a2');
    expect(screen.getByText(/ร้านกาแฟ A/)).toBeTruthy();

    // Rerender on the same date with Building A removed (only Building B remains)
    const refreshedItems = historyItems.filter((item) => item.building_id === 'b-b');
    rerender(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={false}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={vi.fn()}
        onPrintReceipt={vi.fn()}
        onVoidPayment={vi.fn()}
        paymentHistory={refreshedItems}
        serviceDate="2026-07-31"
      />,
    );

    // Building B is visible and the actual location state is cleared.
    expect(screen.getByText(/ร้านข้าวมันไก่ B/)).toBeTruthy();
    expect((screen.getByLabelText('เลือกตึก') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('เลือกโซน') as HTMLSelectElement).value).toBe('');

    // If Building A returns on another refresh, it must not silently reactivate.
    rerender(
      <PaymentHistorySection
        busy={false}
        currentUserId="user-1"
        historyDate="2026-07-31"
        isManager={false}
        onHistoryDateChange={vi.fn()}
        onOpenReceipt={vi.fn()}
        onPrintReceipt={vi.fn()}
        onVoidPayment={vi.fn()}
        paymentHistory={historyItems}
        serviceDate="2026-07-31"
      />,
    );
    expect((screen.getByLabelText('เลือกตึก') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/ร้านข้าวมันไก่ B/)).toBeTruthy();
  });
});

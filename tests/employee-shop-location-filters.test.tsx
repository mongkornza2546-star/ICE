import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { EmployeeShopPicker } from '../src/features/employee-delivery/EmployeeShopPicker';
import { useEmployeeDeliveryData } from '../src/features/employee-delivery/useEmployeeDeliveryData';
import type { EmployeeDeliveryGateway } from '../src/EmployeeDeliveryWorkspace';
import type { ShopCard } from '../src/types/app';

const shop: ShopCard = {
  round_stop_id: 'stop-a', shop_id: 'shop-a', shop_code: 'A1', shop_name: 'ร้าน A',
  building_id: 'a', building_name: 'A', floor_or_zone: 'ตลาด', sequence_no: 1,
  image_path: null, image_url: null, payment_status: 'unpaid', stop_status: 'pending',
  stop_note: null, today_history: [], today_totals: {},
};
const secondShop: ShopCard = { ...shop, round_stop_id: 'stop-b', shop_id: 'shop-b',
  shop_code: 'B1', shop_name: 'ร้าน B', building_id: 'b', building_name: 'B', floor_or_zone: 'Food World' };

function Harness({ gateway }: { gateway: EmployeeDeliveryGateway }) {
  const data = useEmployeeDeliveryData({ gateway, requestScope: 'dropdown-review', serviceDate: '2026-10-27' });
  return <>
    <button onClick={data.retryLoad}>รีเฟรชทดสอบ</button>
    <output data-testid="actual-zone">{data.selectedZone}</output>
    <output data-testid="actual-building">{data.selectedBuildingId}</output>
    <EmployeeShopPicker {...data} enableAssignedStockFlow={false}
      casualCustomerEntryVisible={false} casualCustomerButtonRef={{ current: null }}
      openCasualCustomer={vi.fn()} openCard={vi.fn()} refreshShopImageUrl={vi.fn()} />
  </>;
}

function setup() {
  const gateway: EmployeeDeliveryGateway = {
    loadReferenceData: vi.fn().mockResolvedValue({
      rounds: [{ id: 'round', service_date: '2026-10-27', name: 'งานประจำวัน', status: 'open', opened_at: '2026-10-27T01:00:00Z' }],
      iceTypes: [],
    }),
    loadShopCards: vi.fn().mockResolvedValue([shop, secondShop]),
    loadEmployeeStockState: vi.fn(), recordEmployeeStockTransfer: vi.fn(),
    recordEmployeeStockReturn: vi.fn(), recordEmployeeStockDamage: vi.fn(), recordDelivery: vi.fn(),
  };
  render(<Harness gateway={gateway} />);
  return { gateway, user: userEvent.setup() };
}

it('filters real shop data and resets the zone when switching buildings', async () => {
  const { user } = setup();
  await screen.findByRole('button', { name: 'เลือกร้าน A1 ร้าน A' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'ตึก' }), 'a');
  await user.selectOptions(screen.getByRole('combobox', { name: 'โซน' }), 'ตลาด');
  expect(screen.queryByRole('button', { name: 'เลือกร้าน B1 ร้าน B' })).toBeNull();
  await user.selectOptions(screen.getByRole('combobox', { name: 'ตึก' }), 'b');
  expect(screen.getByTestId('actual-zone').textContent).toBe('');
  expect(screen.queryByRole('option', { name: 'ตลาด' })).toBeNull();
  expect(screen.getByRole('button', { name: 'เลือกร้าน B1 ร้าน B' })).toBeTruthy();
});

it('keeps the displayed zone consistent with the applied filter after data refresh', async () => {
  const { gateway, user } = setup();
  await screen.findByRole('button', { name: 'เลือกร้าน A1 ร้าน A' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'โซน' }), 'ตลาด');
  vi.mocked(gateway.loadShopCards).mockResolvedValue([{ ...shop, floor_or_zone: 'โซนใหม่' }, secondShop]);
  await user.click(screen.getByRole('button', { name: 'รีเฟรชทดสอบ' }));
  await screen.findByRole('option', { name: 'โซนใหม่' });
  const select = screen.getByRole('combobox', { name: 'โซน' }) as HTMLSelectElement;
  expect(select.value, `Displayed: ${select.selectedOptions[0]?.textContent}; applied: ${screen.getByTestId('actual-zone').textContent}; empty: ${!!screen.queryByText('ไม่พบร้าน')}`)
    .toBe(screen.getByTestId('actual-zone').textContent);
  expect(select.selectedOptions[0].textContent).toBe('ตลาด (ไม่อยู่ในรายการ)');
  await user.selectOptions(select, '');
  expect(screen.getByTestId('actual-zone').textContent).toBe('');
  expect(screen.getByRole('button', { name: 'เลือกร้าน A1 ร้าน A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'เลือกร้าน B1 ร้าน B' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'ตลาด (ไม่อยู่ในรายการ)' })).toBeNull();
});

it('shows a missing building honestly and lets the user clear both filters', async () => {
  const { gateway, user } = setup();
  await screen.findByRole('button', { name: 'เลือกร้าน A1 ร้าน A' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'ตึก' }), 'a');
  await user.selectOptions(screen.getByRole('combobox', { name: 'โซน' }), 'ตลาด');
  vi.mocked(gateway.loadShopCards).mockResolvedValue([secondShop]);
  await user.click(screen.getByRole('button', { name: 'รีเฟรชทดสอบ' }));
  await waitFor(() => expect(screen.queryByRole('option', { name: 'A' })).toBeNull());
  const select = screen.getByRole('combobox', { name: 'ตึก' }) as HTMLSelectElement;
  expect(select.value).toBe(screen.getByTestId('actual-building').textContent);
  expect(select.selectedOptions[0].textContent).toBe('ตึกที่เลือกไม่อยู่ในรายการ');
  await user.selectOptions(select, '');
  expect(screen.getByTestId('actual-building').textContent).toBe('');
  expect(screen.getByTestId('actual-zone').textContent).toBe('');
  expect(screen.getByRole('button', { name: 'เลือกร้าน B1 ร้าน B' })).toBeTruthy();
});

it('keeps a valid selection when a refresh fails', async () => {
  const { gateway, user } = setup();
  await screen.findByRole('button', { name: 'เลือกร้าน A1 ร้าน A' });
  await user.selectOptions(screen.getByRole('combobox', { name: 'ตึก' }), 'a');
  await user.selectOptions(screen.getByRole('combobox', { name: 'โซน' }), 'ตลาด');
  vi.mocked(gateway.loadShopCards).mockRejectedValue(new Error('Network error'));
  await user.click(screen.getByRole('button', { name: 'รีเฟรชทดสอบ' }));
  expect((screen.getByRole('combobox', { name: 'ตึก' }) as HTMLSelectElement).value).toBe('a');
  expect((screen.getByRole('combobox', { name: 'โซน' }) as HTMLSelectElement).value).toBe('ตลาด');
  expect(screen.getByRole('button', { name: 'เลือกร้าน A1 ร้าน A' })).toBeTruthy();
});

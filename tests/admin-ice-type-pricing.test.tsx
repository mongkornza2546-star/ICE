import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IceTypePriceEditor } from '../src/features/admin-reference-settings/components/IceTypePriceEditor';
import * as service from '../src/features/admin-reference-settings/adminReferenceSettingsService';
import type { IceTypeOption } from '../src/types/app';

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', async (importOriginal) => {
  const actual = await importOriginal<typeof service>();
  return {
    ...actual,
    loadIceTypePrices: vi.fn(),
    saveIceTypePrice: vi.fn(),
  };
});

const iceTypes: IceTypeOption[] = [
  { id: 'ice-block', code: 'BLOCK', name: 'ก้อน', unit: 'ถุง' },
  { id: 'ice-small', code: 'SMALL', name: 'หลอดเล็ก', unit: 'ถุง' },
];

describe('IceTypePriceEditor Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(service.loadIceTypePrices).mockResolvedValue([
      {
        id: 'price-1',
        ice_type_id: 'ice-block',
        unit_price: 40.0,
        valid_from: '2026-01-01',
        valid_to: null,
        is_active: true,
      },
    ]);
    vi.mocked(service.saveIceTypePrice).mockResolvedValue({
      id: 'price-2',
      ice_type_id: 'ice-block',
      unit_price: 45.0,
      valid_from: '2026-07-21',
      valid_to: null,
      is_active: true,
    });
  });

  it('renders standard ice type prices and history', async () => {
    render(<IceTypePriceEditor iceTypes={iceTypes} />);

    expect(await screen.findByRole('heading', { name: 'ราคากลางรายชนิดน้ำแข็ง' })).toBeTruthy();
    expect(await screen.findByText('฿40.00')).toBeTruthy();
    expect(service.loadIceTypePrices).toHaveBeenCalledWith('ice-block');
  });

  it('saves a new standard ice type price', async () => {
    const user = userEvent.setup();
    render(<IceTypePriceEditor iceTypes={iceTypes} />);

    await screen.findByText('฿40.00');

    const priceInput = screen.getByLabelText(/ราคากลางต่อถุง/i);
    await user.clear(priceInput);
    await user.type(priceInput, '45.00');

    const submitBtn = screen.getByRole('button', { name: 'บันทึกราคากลางใหม่' });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(service.saveIceTypePrice).toHaveBeenCalledWith({
        ice_type_id: 'ice-block',
        unit_price: 45,
        valid_from: expect.any(String),
        valid_to: null,
      });
    });
  });
});

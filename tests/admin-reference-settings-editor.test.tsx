import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IceTypeEditor } from '../src/features/admin-reference-settings/components/IceTypeEditor';
import * as service from '../src/features/admin-reference-settings/adminReferenceSettingsService';
import type { IceTypeSetting } from '../src/features/admin-reference-settings/types';

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', async (importOriginal) => {
  const actual = await importOriginal<typeof service>();
  return {
    ...actual,
    getIceTypeImageSignedUrl: vi.fn(),
    loadIceTypePrices: vi.fn(),
    saveIceType: vi.fn(),
    saveIceTypePrice: vi.fn(),
  };
});

const iceType: IceTypeSetting = {
  id: 'ice-1',
  code: 'ICE-1',
  name: 'หลอดเล็ก',
  unit: 'ถุง',
  image_path: null,
  is_active: true,
};

describe('admin reference settings editor integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(service.loadIceTypePrices).mockResolvedValue([]);
    vi.mocked(service.saveIceTypePrice).mockResolvedValue({
      id: 'price-1',
      ice_type_id: iceType.id,
      unit_price: 45,
      valid_from: '2026-07-23',
      valid_to: null,
      is_active: true,
    });
  });

  it('keeps price and image forms outside the ice-type details form', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IceTypeEditor iceTypes={[iceType]} onIceTypeSaved={vi.fn()} />,
    );

    expect(container.querySelector('form form')).toBeNull();

    await screen.findByText('ยังไม่มีการตั้งราคากลางสำหรับชนิดน้ำแข็งนี้');
    await user.type(screen.getByLabelText(/ราคากลางต่อถุง/), '45');
    await user.click(screen.getByRole('button', { name: 'บันทึกราคากลางใหม่' }));

    await waitFor(() => expect(service.saveIceTypePrice).toHaveBeenCalledOnce());
    expect(service.saveIceType).not.toHaveBeenCalled();
  });
});

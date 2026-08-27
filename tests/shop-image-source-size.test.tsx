import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  getShopImagePublicUrl: vi.fn(),
  removeShopImageFiles: vi.fn(),
  updateShopImagePath: vi.fn(),
  uploadShopImage: vi.fn(),
}));

import { ShopImageEditor } from '../src/features/admin-reference-settings/components/ShopImageEditor';

Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: vi.fn(() => 'blob:shop-image-preview'),
});
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  value: vi.fn(),
});

const shop = {
  id: 'shop-1',
  code: 'BB33',
  name: 'ร้านขนมปราง',
  image_path: null,
  status: 'active' as const,
};

function imageWithSize(size: number) {
  const file = new File(['image'], 'shop.jpg', { type: 'image/jpeg' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function renderEditor() {
  const view = render(<ShopImageEditor onShopSaved={vi.fn()} shop={shop} />);
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Shop image file input was not rendered');
  return input;
}

describe('shop image source size validation', () => {
  it('accepts a source image over 5 MB so it can be compressed before upload', async () => {
    const input = renderEditor();

    await userEvent.upload(input, imageWithSize(6 * 1024 * 1024));

    expect(screen.getByText('ไฟล์ใหม่: shop.jpg')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'บันทึกรูปร้าน' }).disabled).toBe(false);
  });

  it('rejects a source image over 25 MB before decoding it on the device', async () => {
    const input = renderEditor();

    await userEvent.upload(input, imageWithSize(25 * 1024 * 1024 + 1));

    expect(screen.getByRole('alert').textContent).toBe('รูปต้นฉบับต้องมีขนาดไม่เกิน 25 MB');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'บันทึกรูปร้าน' }).disabled).toBe(true);
  });
});

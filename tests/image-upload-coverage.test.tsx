import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  invoke: vi.fn(),
  optimizeImage: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('../src/lib/imageOptimizer', () => ({
  optimizeImage: mocks.optimizeImage,
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    functions: { invoke: mocks.invoke },
    storage: { from: mocks.storageFrom },
  },
}));

import { uploadIceTypeImage, uploadShopImage } from '../src/features/admin-reference-settings/adminReferenceSettingsService';
import { uploadDailyCreditAcknowledgementEvidence } from '../src/lib/dailyCreditAcknowledgementEvidence';
import { uploadPaymentEvidence } from '../src/lib/paymentEvidence';
import { uploadTankImage } from '../src/lib/tankImage';

describe('image upload compression coverage', () => {
  let sourceImage: File;
  let optimizedImage: File;

  beforeEach(() => {
    sourceImage = new File(['source'], 'source.jpg', { type: 'image/jpeg' });
    optimizedImage = new File(['optimized'], 'source.webp', { type: 'image/webp' });
    mocks.optimizeImage.mockResolvedValue(optimizedImage);
    mocks.upload.mockResolvedValue({ error: null });
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
    mocks.storageFrom.mockReturnValue({ upload: mocks.upload });
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });

  it.each([
    ['shop image', () => uploadShopImage('shop-1', sourceImage)],
    ['product image', () => uploadIceTypeImage('ice-1', sourceImage)],
    ['tank image', () => uploadTankImage('shop-1', sourceImage)],
    ['payment evidence image', () => uploadPaymentEvidence(sourceImage, 'request-1')],
    ['credit sign-off image', () => uploadDailyCreditAcknowledgementEvidence(sourceImage, 'document-1')],
  ])('optimizes %s to WebP before upload', async (_label, uploadFile) => {
    const path = await uploadFile();

    expect(mocks.optimizeImage).toHaveBeenCalledWith(sourceImage);
    expect(path).toMatch(/\/r2\/.*\.webp$/);
    expect(mocks.invoke).toHaveBeenCalledWith('r2-storage', {
      body: expect.any(FormData),
    });
  });

  it('preserves payment evidence PDFs without image compression', async () => {
    const pdf = new File(['pdf'], 'receipt.pdf', { type: 'application/pdf' });

    const path = await uploadPaymentEvidence(pdf, 'request-1');

    expect(mocks.optimizeImage).not.toHaveBeenCalled();
    expect(path).toMatch(/^user-1\/r2\/request-1-[a-f0-9]{16}\.pdf$/);
    expect(mocks.invoke).toHaveBeenCalledWith('r2-storage', {
      body: expect.any(FormData),
    });
    expect(mocks.upload).toHaveBeenCalledWith(
      path,
      expect.any(Blob),
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });

  it('rejects oversized payment evidence before uploading', async () => {
    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf', {
      type: 'application/pdf',
    });

    await expect(uploadPaymentEvidence(oversized, 'request-1')).rejects.toThrow(
      'หลักฐานต้องมีขนาดไม่เกิน 5 MB',
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

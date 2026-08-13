import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
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
    mocks.storageFrom.mockReturnValue({ upload: mocks.upload });
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  });

  it.each([
    ['shop image', () => uploadShopImage('shop-1', sourceImage), 'shop-images'],
    ['product image', () => uploadIceTypeImage('ice-1', sourceImage), 'ice-type-images'],
    ['tank image', () => uploadTankImage('shop-1', sourceImage), 'tank-images'],
    ['payment evidence image', () => uploadPaymentEvidence(sourceImage, 'request-1'), 'payment-evidence'],
    ['credit sign-off image', () => uploadDailyCreditAcknowledgementEvidence(sourceImage, 'document-1'), 'credit-signoff-evidence'],
  ])('optimizes %s to WebP before upload', async (_label, uploadFile, bucket) => {
    const path = await uploadFile();

    expect(mocks.optimizeImage).toHaveBeenCalledWith(sourceImage);
    expect(mocks.storageFrom).toHaveBeenCalledWith(bucket);
    expect(path).toMatch(/\.webp$/);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.stringMatching(/\.webp$/),
      optimizedImage,
      expect.objectContaining({ contentType: 'image/webp' }),
    );
  });

  it('preserves payment evidence PDFs without image compression', async () => {
    const pdf = new File(['pdf'], 'receipt.pdf', { type: 'application/pdf' });

    const path = await uploadPaymentEvidence(pdf, 'request-1');

    expect(mocks.optimizeImage).not.toHaveBeenCalled();
    expect(path).toBe('user-1/request-1.pdf');
    expect(mocks.upload).toHaveBeenCalledWith(
      path,
      pdf,
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });
});

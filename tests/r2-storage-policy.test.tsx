import { describe, expect, it } from 'vitest';
import {
  canDeleteR2Objects,
  canSignR2Object,
  canUploadR2Object,
  isAllowedR2MimeType,
} from '../supabase/functions/r2-storage/policy';

describe('R2 storage policy', () => {
  const ownerId = 'user-owner';
  const otherId = 'user-other';

  it('matches the existing evidence read policies', () => {
    const paymentPath = `${ownerId}/r2/payment.pdf`;
    const creditPath = `${ownerId}/document/r2/signoff.webp`;

    expect(canSignR2Object('payment-evidence', paymentPath, ownerId, 'courier')).toBe(true);
    expect(canSignR2Object('payment-evidence', paymentPath, otherId, 'round_lead')).toBe(true);
    expect(canSignR2Object('payment-evidence', paymentPath, otherId, 'courier')).toBe(false);
    expect(canSignR2Object('credit-signoff-evidence', creditPath, otherId, 'courier')).toBe(true);
  });

  it('keeps evidence writes owner-scoped and catalog writes admin-scoped', () => {
    expect(canUploadR2Object('payment-evidence', `${ownerId}/r2/payment.pdf`, ownerId, 'courier')).toBe(true);
    expect(canUploadR2Object('payment-evidence', `${ownerId}/r2/payment.pdf`, otherId, 'courier')).toBe(false);
    expect(canUploadR2Object('shop-images', 'shops/shop-1/r2/photo.webp', ownerId, 'round_lead')).toBe(false);
    expect(canUploadR2Object('shop-images', 'shops/shop-1/r2/photo.webp', ownerId, 'admin')).toBe(true);
    expect(canDeleteR2Objects('tank-images', ['shop-1/r2/tank.webp'], ownerId, 'round_lead')).toBe(false);
  });

  it('rejects content types outside each namespace contract', () => {
    expect(isAllowedR2MimeType('shop-images', 'image/webp')).toBe(true);
    expect(isAllowedR2MimeType('payment-evidence', 'application/pdf')).toBe(true);
    expect(isAllowedR2MimeType('credit-signoff-evidence', 'application/pdf')).toBe(false);
    expect(isAllowedR2MimeType('payment-evidence', 'text/html')).toBe(false);
    expect(isAllowedR2MimeType('user-avatars', 'image/svg+xml')).toBe(false);
  });
});

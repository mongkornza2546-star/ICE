import { describe, expect, it, vi } from 'vitest';
import {
  canDeleteR2Objects,
  canSignR2Object,
  canSignR2Objects,
  canUploadR2Object,
  isAllowedR2MimeType,
  signedUrlTtlSeconds,
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
    expect(canDeleteR2Objects('payment-evidence', [`${ownerId}/r2/payment.pdf`], otherId, 'courier')).toBe(false);
    expect(canUploadR2Object('shop-images', 'shops/shop-1/r2/photo.webp', ownerId, 'round_lead')).toBe(false);
    expect(canUploadR2Object('shop-images', 'shops/shop-1/r2/photo.webp', ownerId, 'admin')).toBe(true);
    expect(canDeleteR2Objects('tank-images', ['shop-1/r2/tank.webp'], ownerId, 'round_lead')).toBe(false);
  });

  it('shares attached evidence only when the caller can read its payment', async () => {
    const path = `${ownerId}/r2/payment.pdf`;
    const lookup = vi.fn().mockResolvedValue([path]);
    expect(await canSignR2Objects('payment-evidence', [path], otherId, 'courier', lookup)).toBe(true);
    expect(lookup).toHaveBeenCalledWith([path]);
    lookup.mockResolvedValue([]);
    expect(await canSignR2Objects('payment-evidence', [path], otherId, 'courier', lookup)).toBe(false);
  });

  it('checks every shared attachment in a mixed batch and deduplicates the lookup', async () => {
    const ownPath = `${otherId}/r2/preview.webp`;
    const sharedPath = `${ownerId}/r2/payment.pdf`;
    const privatePath = `${ownerId}/r2/unattached.webp`;
    const lookup = vi.fn().mockResolvedValue([sharedPath]);
    expect(await canSignR2Objects('payment-evidence', [ownPath, sharedPath, sharedPath], otherId, 'courier', lookup)).toBe(true);
    expect(lookup).toHaveBeenCalledWith([sharedPath]);
    expect(await canSignR2Objects('payment-evidence', [sharedPath, privatePath], otherId, 'courier', lookup)).toBe(false);
  });

  it('preserves existing previews and rejects invalid paths before looking up payments', async () => {
    const path = `${ownerId}/r2/preview.webp`;
    const lookup = vi.fn();
    expect(await canSignR2Objects('payment-evidence', [path], ownerId, 'courier', lookup)).toBe(true);
    expect(await canSignR2Objects('payment-evidence', [path], otherId, 'round_lead', lookup)).toBe(true);
    expect(await canSignR2Objects('payment-evidence', [`${ownerId}/r2/../secret`], otherId, 'courier', lookup)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects content types outside each namespace contract', () => {
    expect(isAllowedR2MimeType('shop-images', 'image/webp')).toBe(true);
    expect(isAllowedR2MimeType('payment-evidence', 'application/pdf')).toBe(true);
    expect(isAllowedR2MimeType('credit-signoff-evidence', 'application/pdf')).toBe(false);
    expect(isAllowedR2MimeType('payment-evidence', 'text/html')).toBe(false);
    expect(isAllowedR2MimeType('user-avatars', 'image/svg+xml')).toBe(false);
  });

  it('keeps public catalog links alive for a work week without extending private evidence links', () => {
    expect(signedUrlTtlSeconds('shop-images')).toBe(7 * 24 * 60 * 60);
    expect(signedUrlTtlSeconds('ice-type-images')).toBe(7 * 24 * 60 * 60);
    expect(signedUrlTtlSeconds('payment-evidence')).toBe(60 * 60);
    expect(signedUrlTtlSeconds('credit-signoff-evidence')).toBe(60 * 60);
  });
});

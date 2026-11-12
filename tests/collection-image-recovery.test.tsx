import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ invoke: vi.fn(), publicUrl: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  functions: { invoke: backend.invoke },
  storage: { from: () => ({ getPublicUrl: backend.publicUrl }) },
} }));
import { AutoRefreshShopImage } from '../src/features/financial-operations/components/AutoRefreshShopImage';
import { CollectionDesk } from '../src/features/financial-operations/components/CollectionDesk';
import { clearR2CatalogUrlCache } from '../src/lib/r2Storage';
import type { QueueShop } from '../src/features/financial-operations/types';
const path = 'shops/recovery/r2/photo.webp';
const url = 'https://r2.test/recovery.webp';
beforeEach(() => {
  clearR2CatalogUrlCache();
  backend.invoke.mockReset().mockResolvedValue({ data: { signedUrls: [{ path, signedUrl: url }] }, error: null });
  backend.publicUrl.mockReset().mockImplementation((path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }));
});
afterEach(cleanup);
it('resolves a legacy snapshot through the real hybrid resolver', async () => {
  render(<AutoRefreshShopImage alt="Legacy" imagePath="shops/legacy.jpg" fallback={<span>Missing</span>} />);
  await waitFor(() => expect(screen.getByAltText('Legacy').getAttribute('src')).toBe('https://storage.test/shops/legacy.jpg'));
  expect(backend.publicUrl).toHaveBeenCalledWith('shops/legacy.jpg');
  expect(backend.invoke).not.toHaveBeenCalled();
});
it('reuses an unexpired signed URL on a byte-cache miss', async () => {
  const first = render(<AutoRefreshShopImage alt="First" imagePath={path} fallback={null} />);
  await waitFor(() => expect(screen.getByAltText('First').getAttribute('src')).toBe(url));
  first.unmount();
  render(<AutoRefreshShopImage alt="Second" imagePath={path} fallback={null} />);
  await waitFor(() => expect(screen.getByAltText('Second').getAttribute('src')).toBe(url));
  expect(backend.invoke).toHaveBeenCalledTimes(1);
});
it('the collection refresh button retries a failed image with the same queue', async () => {
  backend.invoke.mockResolvedValueOnce({ data: null, error: new Error('temporary failure') });
  const shop: QueueShop = {
    shop_id: 'shop', shop_code: 'BB24', shop_name: 'Test shop', image_path: path,
    outstanding_amount: 60, charge_count: 1, has_new_charges: false, charges: [],
    payment_profile: { allowed_payment_methods: ['cash'], default_payment_method: 'cash',
      cash_reference_required: false, cash_evidence_required: false,
      bank_transfer_reference_required: false, bank_transfer_evidence_required: false,
      qr_reference_required: false, qr_evidence_required: false },
  };
  const refresh = vi.fn();
  const view = render(<CollectionDesk busy={false} historyDate="2026-11-11" serviceDate="2026-11-11"
    onClearShop={vi.fn()} onHistoryDateChange={vi.fn()} onOpenReceipt={vi.fn()} onPrintReceipt={vi.fn()}
    onRefresh={refresh} onSelectShop={vi.fn()} onVoidPayment={vi.fn()} paymentHistory={[]} paymentPanel={null}
    queue={[shop]} runId="run" selectedShop={null} todayPayments={[]} />);
  await waitFor(() => expect(backend.invoke).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.container.querySelector('.financial-ops__shop-visual img')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชยอดล่าสุด' }));
  await waitFor(() => expect(view.container.querySelector('.financial-ops__shop-visual img')?.getAttribute('src')).toBe(url));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(backend.invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'รีเฟรชยอดล่าสุด' }));
  expect(backend.invoke).toHaveBeenCalledTimes(2);
});

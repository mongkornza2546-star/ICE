import { beforeEach, expect, it, vi } from 'vitest';
import { getStoredPaymentEvidence } from '../src/lib/paymentEvidence';

const mocks = vi.hoisted(() => ({
  single: vi.fn(), eq: vi.fn(), select: vi.fn(), from: vi.fn(),
  createSignedUrl: vi.fn(), storageFrom: vi.fn(), invoke: vi.fn(),
}));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  from: mocks.from, storage: { from: mocks.storageFrom }, functions: { invoke: mocks.invoke },
} }));

beforeEach(() => {
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ single: mocks.single });
  mocks.storageFrom.mockReturnValue({ createSignedUrl: mocks.createSignedUrl });
  mocks.single.mockReset();
  mocks.invoke.mockReset();
  mocks.createSignedUrl.mockReset();
});

it('reads only the selected payment and signs legacy Supabase evidence', async () => {
  mocks.single.mockResolvedValue({ data: { evidence_path: 'user/slip.PDF' }, error: null });
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.com/legacy.pdf' }, error: null });
  expect(await getStoredPaymentEvidence('payment-1')).toEqual({ url: 'https://example.com/legacy.pdf', isPdf: true });
  expect(mocks.from).toHaveBeenCalledWith('payments');
  expect(mocks.select).toHaveBeenCalledWith('evidence_path');
  expect(mocks.eq).toHaveBeenCalledWith('id', 'payment-1');
  expect(mocks.storageFrom).toHaveBeenCalledWith('payment-evidence');
  expect(mocks.createSignedUrl).toHaveBeenCalledWith('user/slip.PDF', 3600);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('signs current R2 evidence through the storage function', async () => {
  mocks.single.mockResolvedValue({ data: { evidence_path: 'user/r2/slip.webp' }, error: null });
  mocks.invoke.mockResolvedValue({ data: { signedUrl: 'https://example.com/r2.webp' }, error: null });
  expect(await getStoredPaymentEvidence('payment-2')).toEqual({ url: 'https://example.com/r2.webp', isPdf: false });
  expect(mocks.invoke).toHaveBeenCalledWith('r2-storage', { body: {
    action: 'sign', namespace: 'payment-evidence', path: 'user/r2/slip.webp',
  } });
  expect(mocks.createSignedUrl).not.toHaveBeenCalled();
});

it('does not request a signed URL when no evidence was attached', async () => {
  mocks.single.mockResolvedValue({ data: { evidence_path: null }, error: null });
  expect(await getStoredPaymentEvidence('payment-3')).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.createSignedUrl).not.toHaveBeenCalled();
});

it('propagates payment access errors without trying to sign a file', async () => {
  mocks.single.mockResolvedValue({ data: null, error: new Error('ไม่มีสิทธิ์อ่านรายการนี้') });
  await expect(getStoredPaymentEvidence('hidden-payment')).rejects.toThrow('ไม่มีสิทธิ์อ่านรายการนี้');
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.createSignedUrl).not.toHaveBeenCalled();
});

it('propagates legacy storage signing failures', async () => {
  mocks.single.mockResolvedValue({ data: { evidence_path: 'user/slip.jpg' }, error: null });
  mocks.createSignedUrl.mockResolvedValue({ data: null, error: new Error('ไม่พบไฟล์') });
  await expect(getStoredPaymentEvidence('payment-4')).rejects.toThrow('ไม่พบไฟล์');
});

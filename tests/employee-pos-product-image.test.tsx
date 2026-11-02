import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeeDeliveryReview } from '../src/features/employee-delivery/EmployeeDeliveryReview';
import { EmployeePosProductImage } from '../src/features/employee-delivery/EmployeePosProductImage';
import type { DeliveryPosContext, DeliveryRound, ShopCard } from '../src/types/app';

const mocks = vi.hoisted(() => ({ load: vi.fn(), read: vi.fn(), getUrl: vi.fn(), refresh: vi.fn() }));
vi.mock('../src/lib/catalogImageCache', async (original) => ({
  ...await original<typeof import('../src/lib/catalogImageCache')>(),
  loadCatalogImage: mocks.load,
  readCatalogImageByPath: mocks.read,
}));
vi.mock('../src/lib/r2Storage', async (original) => ({
  ...await original<typeof import('../src/lib/r2Storage')>(),
  getR2ObjectUrl: mocks.getUrl,
  refreshR2CatalogObjectUrl: mocks.refresh,
}));
const path = 'ice-types/ice-1/r2/photo.webp';
const expiredUrl = `https://bucket.account.r2.cloudflarestorage.com/ice-type-images/${path}?X-Amz-Signature=expired`;
const freshUrl = expiredUrl.replace('expired', 'fresh');
const pixels = new Blob(['pixels'], { type: 'image/webp' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReset().mockResolvedValue(pixels);
  mocks.read.mockReset().mockResolvedValue(null);
  mocks.getUrl.mockReset().mockResolvedValue(freshUrl);
  mocks.refresh.mockReset().mockResolvedValue(freshUrl);
  vi.stubGlobal('caches', {});
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => 'blob:product';
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const round: DeliveryRound = {
  id: 'round-1',
  service_date: '2026-08-18',
  name: 'รอบเช้า',
  status: 'open',
  opened_at: '2026-08-18T01:00:00Z',
};

const shopCard: ShopCard = {
  round_stop_id: 'stop-1',
  shop_id: 'shop-1',
  shop_code: 'BB2',
  shop_name: 'ร้านผัดไทโบราณี',
  building_id: 'building-1',
  building_name: 'ศูนย์อาหารฝั่ง Top',
  floor_or_zone: 'B',
  sequence_no: 1,
  image_path: null,
  image_url: null,
  payment_status: 'unpaid',
  stop_status: 'pending',
  stop_note: null,
  today_history: [],
  today_totals: {},
};

const posContext: DeliveryPosContext = {
  round_id: round.id,
  round_stop_id: shopCard.round_stop_id,
  service_date: round.service_date,
  shop: {
    id: shopCard.shop_id,
    code: shopCard.shop_code,
    name: shopCard.shop_name,
    building_name: shopCard.building_name,
    floor_or_zone: shopCard.floor_or_zone,
    image_path: null,
  },
  stock_source: { id: 'stock-1', code: 'STOCK', name: 'สต๊อกรวมประจำวัน', kind: 'aggregate' },
  items: [{
    ice_type_id: 'ice-1',
    code: 'SMALL',
    name: 'หลอดเล็ก',
    unit: 'ถุง',
    image_path: null,
    stock_quantity: 167,
    unit_price: 60,
    price_source: 'standard',
    price_source_id: 'price-1',
  }],
  payment_profile: {
    allowed_payment_terms: ['immediate', 'end_of_day'],
    default_payment_term: 'end_of_day',
    allowed_payment_methods: ['cash'],
    default_payment_method: 'cash',
    cash_reference_required: false,
    cash_evidence_required: false,
    bank_transfer_reference_required: false,
    bank_transfer_evidence_required: false,
    qr_reference_required: false,
    qr_evidence_required: false,
    allow_outstanding: true,
    credit_due_rule: null,
    credit_days: null,
    credit_collection_weekday: null,
    credit_limit: null,
    credit_exposure: 0,
    credit_remaining: null,
    credit_suspended: false,
  },
};

function renderReview(canCollectImmediatePayment = true, card = shopCard, overrides: Partial<ComponentProps<typeof EmployeeDeliveryReview>> = {}) {
  const onSubmit = vi.fn((event) => event.preventDefault());
  const onConfirmDelivery = vi.fn();
  function ReviewWithQuantities() {
    const [quantities, setQuantities] = useState<Record<string, number>>({ 'ice-1': 2 });
    return <EmployeeDeliveryReview
    round={round}
    shopCard={card}
    atomicImmediateSale={false}
    canCollectImmediatePayment={canCollectImmediatePayment}
    assignedStockState={null}
    deliveryQuantities={quantities}
    posContext={posContext}
    posContextError={null}
    loadingPosContext={false}
    paymentResult={null}
    paymentOpen={false}
    paymentMethod="cash"
    paymentAmount=""
    paymentReference=""
    paymentEvidence={null}
    paymentEvidenceUploaded={false}
    paymentSubmitting={false}
    approvalId={null}
    approvalReason=""
    approvalSubmitting={false}
    enableAssignedStockFlow={false}
    iceTypes={[]}
    items={Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([ice_type_id, quantity]) => ({ ice_type_id, quantity }))}
    status="delivered"
    stockSourceLabel="สต๊อกรวมประจำวัน"
    shopCards={[card]}
    note=""
    problemOpen={false}
    submitting={false}
    entryError={null}
    onBack={vi.fn()}
    onChangeShop={vi.fn()}
    onSubmit={onSubmit}
    onChooseProblemStatus={vi.fn()}
    onClearCart={vi.fn()}
    onConfirmDelivery={onConfirmDelivery}
    onPaymentMethodChange={vi.fn()}
    onPaymentAmountChange={vi.fn()}
    onPaymentReferenceChange={vi.fn()}
    onPaymentEvidenceChange={vi.fn()}
    onPaymentCancel={vi.fn()}
    onPaymentSubmit={vi.fn()}
    onApprovalReasonChange={vi.fn()}
    onRequestApproval={vi.fn()}
    onNoteChange={vi.fn()}
    onReturnToDelivery={vi.fn()}
    onCorrectionSuccess={vi.fn()}
    {...overrides}
    onSetQuantity={(id, quantity) => {
      overrides.onSetQuantity?.(id, quantity);
      setQuantities((current) => ({ ...current, [id]: Math.min(167, Math.max(0, Math.round(quantity * 2) / 2)) }));
    }}
  />;
  }
  render(<ReviewWithQuantities />);
  return { onSubmit, onConfirmDelivery };
}

function showProduct(imageUrl: string | null = expiredUrl, imagePath = path) {
  renderReview(true, shopCard, {
    posContext: { ...posContext, items: [{ ...posContext.items[0], image_path: imagePath, image_url: imageUrl }] },
  });
}
const productImage = () => document.querySelector<HTMLImageElement>('img.employee-pos-product-image');

describe('POS product image recovery through the actual delivery screen', () => {
  it('refreshes a failed signed URL once and displays the recovered image', async () => {
    mocks.load.mockRejectedValueOnce(new Error('HTTP 403'));
    showProduct();
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe(expiredUrl));
    fireEvent.error(productImage()!);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith('ice-type-images', path));
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe('blob:product'));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('requests a URL when restored product data has a path but the disk cache is empty', async () => {
    showProduct(null);
    await waitFor(() => expect(mocks.read).toHaveBeenCalled());
    await waitFor(() => expect(mocks.getUrl).toHaveBeenCalledWith('ice-type-images', path));
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe('blob:product'));
  });

  it('uses cached product bytes without signing or downloading again', async () => {
    mocks.read.mockResolvedValue(pixels);
    showProduct(null);
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe('blob:product'));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('replaces a failed ordinary image with the icon instead of leaving a broken image', async () => {
    vi.stubGlobal('caches', undefined);
    showProduct('https://example.com/missing.webp', 'legacy/photo.webp');
    fireEvent.error(productImage()!);
    await waitFor(() => expect(productImage()).toBeNull());
    expect(document.querySelector('span.employee-pos-product-image svg')).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('recovers path-only products even when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    showProduct(null);
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe(freshUrl));
    expect(mocks.getUrl).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('stops after one refresh when the replacement image also fails', async () => {
    mocks.load.mockRejectedValue(new Error('network unavailable'));
    showProduct();
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe(expiredUrl));
    fireEvent.error(productImage()!);
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe(freshUrl));
    fireEvent.error(productImage()!);
    await waitFor(() => expect(productImage()).toBeNull());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the fallback when signing fails without preventing product selection', async () => {
    mocks.getUrl.mockRejectedValue(new Error('offline'));
    showProduct(null);
    await waitFor(() => expect(mocks.getUrl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(productImage()).toBeNull());
    const product = screen.getByText('หลอดเล็ก', { selector: '.employee-pos-product-grid strong' }).closest('button')!;
    expect(product.disabled).toBe(false);
    fireEvent.click(product);
    expect(product.getAttribute('aria-pressed')).toBe('true');
  });

  it('retries even when the signer returns the same URL', async () => {
    mocks.refresh.mockResolvedValue(expiredUrl);
    mocks.load.mockRejectedValueOnce(new Error('temporary failure'));
    showProduct();
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe(expiredUrl));
    fireEvent.error(productImage()!);
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe('blob:product'));
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('ignores a late signed URL after the catalog image changes', async () => {
    let finish!: (url: string) => void;
    mocks.getUrl.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const view = render(<EmployeePosProductImage imagePath={path} />);
    await waitFor(() => expect(mocks.getUrl).toHaveBeenCalledTimes(1));
    const replacement = expiredUrl.replace('photo.webp', 'replacement.webp');
    view.rerender(<EmployeePosProductImage imagePath={path.replace('photo.webp', 'replacement.webp')} imageUrl={replacement} />);
    await waitFor(() => expect(productImage()?.getAttribute('src')).toBe('blob:product'));
    await act(async () => { finish(freshUrl); });
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledWith(replacement, expect.anything());
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShopPurchaseHistory } from '../src/features/shop-settings/components/ShopPurchaseHistory';

vi.mock('../src/lib/env', () => ({ env: { isDemoMode: true } }));
vi.mock('../src/lib/supabase', () => ({ supabase: null }));

describe('ShopPurchaseHistory', () => {
  it('shows purchase totals, payment states, and filters outstanding purchases', async () => {
    render(<ShopPurchaseHistory isActive shopId="demo-shop-1" />);

    expect(await screen.findByText('C690803-000021')).toBeTruthy();
    expect(screen.getAllByText('ชำระแล้ว')).toHaveLength(2);
    expect(screen.getByText('ชำระบางส่วน')).toBeTruthy();
    expect(screen.getByText('ค้างชำระ')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('สถานะชำระเงิน'), { target: { value: 'outstanding' } });

    await waitFor(() => {
      expect(screen.queryByText('C690803-000021')).toBeNull();
    });
    expect(screen.getByText('C690802-000018')).toBeTruthy();
    expect(screen.getByText('C690801-000011')).toBeTruthy();
  });

  it('does not load until the history tab becomes active', () => {
    render(<ShopPurchaseHistory isActive={false} shopId="demo-shop-1" />);
    expect(screen.queryByText('C690803-000021')).toBeNull();
  });
});

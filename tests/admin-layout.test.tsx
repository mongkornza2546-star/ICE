import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdminLayout } from '../src/AdminLayout';

describe('AdminLayout', () => {
  it('shows collection and credit management as financial sidebar children', async () => {
    const user = userEvent.setup();
    const onFinancialPageChange = vi.fn();
    render(
      <AdminLayout
        activeView="financial_operations"
        allowedViews={['financial_operations']}
        financialPage="collection"
        onFinancialPageChange={onFinancialPageChange}
        onNavigate={() => undefined}
        profileLabel="Admin"
      >
        <p>Financial</p>
      </AdminLayout>,
    );

    expect(screen.getByRole('button', { name: 'เก็บเงินร้านค้า' }).getAttribute('aria-current')).toBe('page');
    await user.click(screen.getByRole('button', { name: 'บัญชี / รายการธุรกรรม' }));
    expect(onFinancialPageChange).toHaveBeenCalledWith('transactions');
    await user.click(screen.getByRole('button', { name: 'ลูกหนี้เครดิต' }));
    expect(onFinancialPageChange).toHaveBeenCalledWith('credit');
    await user.click(screen.getByRole('button', { name: 'คิวคืนเงิน' }));
    expect(onFinancialPageChange).toHaveBeenCalledWith('refund');
  });

  it('lets an admin choose a past billing date without allowing a future date', async () => {
    const user = userEvent.setup();
    const onServiceDateChange = vi.fn();
    render(
      <AdminLayout
        activeView="delivery"
        allowedViews={['delivery']}
        onNavigate={() => undefined}
        onServiceDateChange={onServiceDateChange}
        profileLabel="Admin"
        serviceDate="2026-07-27"
      >
        <p>Delivery</p>
      </AdminLayout>,
    );

    const dateInput = screen.getByLabelText('วันที่ออกบิล') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-07-27');
    expect(dateInput.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    fireEvent.change(dateInput, { target: { value: '2026-07-26' } });
    expect(onServiceDateChange).toHaveBeenLastCalledWith('2026-07-26');

    const futureDate = new Date(`${dateInput.max}T12:00:00+07:00`);
    futureDate.setDate(futureDate.getDate() + 1);
    fireEvent.change(dateInput, { target: { value: futureDate.toISOString().slice(0, 10) } });
    expect(onServiceDateChange).toHaveBeenCalledTimes(1);
  });

  it('lets the reference-settings desktop menu collapse and expand the sidebar', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const { container } = render(
      <AdminLayout
        activeView="reference_settings"
        allowedViews={['reference_settings']}
        onNavigate={() => undefined}
        profileLabel="Admin"
      >
        <p>Settings</p>
      </AdminLayout>,
    );

    const menuButton = screen.getByRole('button', { name: 'เมนู' });
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.admin-shell--reference-settings')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');

    await user.click(menuButton);
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.admin-shell--sidebar-collapsed')).toBeTruthy();

    await user.click(menuButton);
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.admin-shell--sidebar-collapsed')).toBeNull();
  });
});

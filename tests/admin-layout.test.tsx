import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AdminLayout } from '../src/AdminLayout';

describe('AdminLayout', () => {
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

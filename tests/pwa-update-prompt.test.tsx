import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PwaUpdatePrompt } from '../src/PwaUpdatePrompt';
import { requestPwaUpdate } from '../src/pwaUpdateSafety';

vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn(),
}));

describe('PWA lifecycle UI', () => {
  it('shows the offline boundary when connectivity is lost', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    render(<PwaUpdatePrompt />);

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(screen.getByText('กำลังใช้งานแบบออฟไลน์')).not.toBeNull();
    expect(screen.getByText(/ต้องเชื่อมต่ออินเทอร์เน็ตก่อนบันทึกข้อมูล/)).not.toBeNull();
  });

  it('uses the deferred browser prompt when the user chooses install', async () => {
    const user = userEvent.setup();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const installEvent = new Event('beforeinstallprompt');
    Object.assign(installEvent, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    render(<PwaUpdatePrompt />);

    fireEvent(window, installEvent);
    await user.click(await screen.findByRole('button', { name: 'ติดตั้ง' }));

    expect(prompt).toHaveBeenCalledOnce();
  });
});

describe('PWA update safety', () => {
  it('does not reload when the user has not confirmed it is safe', async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);

    await expect(requestPwaUpdate(updateServiceWorker, () => false)).resolves.toBe(false);

    expect(updateServiceWorker).not.toHaveBeenCalled();
  });

  it('applies the update only after explicit confirmation', async () => {
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);

    await expect(requestPwaUpdate(updateServiceWorker, () => true)).resolves.toBe(true);

    expect(updateServiceWorker).toHaveBeenCalledOnce();
  });
});

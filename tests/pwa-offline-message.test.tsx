import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PwaUpdatePrompt } from '../src/PwaUpdatePrompt';

afterEach(() => vi.restoreAllMocks());

it('does not cover the workspace with a prompt while offline', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  try {
    const { container } = render(<PwaUpdatePrompt />);
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

it('hides an existing install prompt when connectivity drops and restores it on reconnect', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  try {
    const { container } = render(<PwaUpdatePrompt />);
    fireEvent(window, new Event('beforeinstallprompt', { cancelable: true }));
    expect(screen.getByRole('status').textContent).toContain('ติดตั้งแอปส่งน้ำแข็ง');

    fireEvent(window, new Event('offline'));
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent(window, new Event('online'));
    expect(screen.getByRole('status').textContent).toContain('ติดตั้งแอปส่งน้ำแข็ง');

    fireEvent(window, new Event('offline'));
    expect(container.childElementCount).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

it('does not show iPhone install help over the workspace when opened offline', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  try {
    const { container } = render(<PwaUpdatePrompt />);
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent(window, new Event('online'));
    expect(screen.getByRole('status').textContent).toContain('เพิ่มแอปลงหน้าจอโฮม');
  } finally { vi.unstubAllGlobals(); }
});

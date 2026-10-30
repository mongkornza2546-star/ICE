import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PwaUpdatePrompt } from '../src/PwaUpdatePrompt';

afterEach(() => vi.restoreAllMocks());

it('explains that prepared work can be saved locally while offline', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  try {
    render(<PwaUpdatePrompt />);
    expect(screen.getByRole('status').textContent).toContain('กดส่งของได้ตามปกติ');
    expect(screen.queryByText('เปิดดูหน้าที่เคยโหลดได้ แต่ต้องเชื่อมต่ออินเทอร์เน็ตก่อนบันทึกข้อมูล')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc } }));
import { AdminReferenceSettings } from '../src/AdminReferenceSettings';

const savedUser = {
  id: 'new-user', code: 'AUTH-NEW', display_name: 'พนักงานใหม่', nickname: 'ใหม่', phone: null,
  avatar_path: null, role: 'courier', is_active: true, can_collect_shop_payments: true,
};
const workSite = { id: '12345678-1234-1234-1234-123456789012', code: 'SITE-1', name: 'จุดหนึ่ง' };
beforeEach(() => { vi.clearAllMocks(); });

async function fillForm(confirmation = 'test-password-123') {
  const user = userEvent.setup();
  render(<AdminReferenceSettings previewData={{ users: [], iceTypes: [], workSites: [workSite], workSiteAssignments: [] }} />);
  await user.click(await screen.findByRole('button', { name: 'เพิ่มพนักงาน' }));
  await user.type(screen.getByLabelText('ชื่อแสดง'), 'พนักงานใหม่');
  await user.type(screen.getByLabelText('ชื่อเล่น (ใช้เข้าสู่ระบบ)'), 'ใหม่');
  await user.type(screen.getByLabelText('รหัสผ่านเริ่มต้น'), 'test-password-123');
  await user.type(screen.getByLabelText('ยืนยันรหัสผ่าน'), confirmation);
  await user.click(screen.getByLabelText('รับเงินร้านค้าได้'));
  await user.click(screen.getByLabelText('จุดหนึ่ง'));
  return user;
}

describe('create employee from reference settings', () => {
  it('rejects nicknames containing @ before creating credentials', async () => {
    const user = await fillForm();
    await user.clear(screen.getByLabelText('ชื่อเล่น (ใช้เข้าสู่ระบบ)'));
    await user.type(screen.getByLabelText('ชื่อเล่น (ใช้เข้าสู่ระบบ)'), 'ree@example.com');
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'ชื่อเล่นต้องไม่มีเครื่องหมาย @');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('creates from an empty user list, shows the new account and clears credentials', async () => {
    mocks.invoke.mockResolvedValue({ data: { user: savedUser, work_site_ids: [workSite.id] }, error: null });
    const user = await fillForm();
    expect(screen.queryByText('รีเซ็ตรหัสผ่าน')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    await screen.findByText('เพิ่มพนักงานแล้ว เข้าสู่ระบบด้วยชื่อเล่นและรหัสผ่านที่กำหนดได้ทันที');
    expect(mocks.invoke).toHaveBeenCalledWith('admin-create-user', { body: {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: 'พนักงานใหม่', nickname: 'ใหม่', phone: '', role: 'courier', isActive: true,
      canCollectShopPayments: true, workSiteIds: [workSite.id], password: 'test-password-123',
    } });
    expect(screen.getByRole('button', { name: /พนักงานใหม่.*พนักงานส่ง/ })).toBeTruthy();
    expect((screen.getByLabelText('รหัสผ่านใหม่') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'บันทึกผู้ใช้' })).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects a password mismatch without making a request', async () => {
    const user = await fillForm('different-password');
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'ยืนยันรหัสผ่านไม่ตรงกัน');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('shows server duplicate errors and preserves the form for correction', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: {
      message: 'Non-2xx response', context: new Response(JSON.stringify({ error: 'ชื่อเล่นนี้มีผู้ใช้แล้ว กรุณาเลือกชื่อเล่นอื่น' }), { status: 409 }),
    } });
    const user = await fillForm();
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'ชื่อเล่นนี้มีผู้ใช้แล้ว กรุณาเลือกชื่อเล่นอื่น');
    expect((screen.getByLabelText('ชื่อเล่น (ใช้เข้าสู่ระบบ)') as HTMLInputElement).value).toBe('ใหม่');
  });

  it('retries a partially created account through profile save without creating another account', async () => {
    const pending = { ...savedUser, nickname: null, is_active: false, can_collect_shop_payments: false };
    mocks.invoke.mockResolvedValue({ data: { user: pending, work_site_ids: [], warning: 'สร้างบัญชีแล้ว กรุณาบันทึกข้อมูลอีกครั้ง' }, error: null });
    mocks.rpc.mockResolvedValue({ data: { user: savedUser, work_site_ids: [workSite.id] }, error: null });
    const user = await fillForm();
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'สร้างบัญชีแล้ว กรุณาบันทึกข้อมูลอีกครั้ง');
    await user.click(screen.getByRole('button', { name: 'บันทึกผู้ใช้' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('save_user_profile_with_work_site_assignments_v2', expect.objectContaining({
      p_user_id: 'new-user', p_nickname: 'ใหม่', p_is_active: true, p_work_site_ids: [workSite.id],
    })));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('prevents switching users or submitting twice while creation is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = await fillForm();
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    expect((screen.getByRole('button', { name: 'เพิ่มพนักงาน' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'ยกเลิก' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    finish({ data: { user: savedUser, work_site_ids: [workSite.id] }, error: null });
    await screen.findByText('เพิ่มพนักงานแล้ว เข้าสู่ระบบด้วยชื่อเล่นและรหัสผ่านที่กำหนดได้ทันที');
  });

  it('reuses the request ID after a lost response, then uses current recovered values', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: {
        user: { ...savedUser, display_name: 'ชื่อที่แก้ภายหลัง', is_active: false },
        work_site_ids: [], warning: 'พบบัญชีเดิม รหัสผ่านยังเป็นค่าเดิม',
      }, error: null });
    const user = await fillForm();
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    await screen.findByRole('alert');
    const requestId = mocks.invoke.mock.calls[0][1].body.requestId;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    await screen.findByRole('button', { name: 'บันทึกผู้ใช้' });
    expect(mocks.invoke.mock.calls[1][1].body.requestId).toBe(requestId);
    expect((screen.getByLabelText('ชื่อแสดง') as HTMLInputElement).value).toBe('ชื่อที่แก้ภายหลัง');
    expect((screen.getByLabelText('เปิดใช้งานบัญชีนี้') as HTMLInputElement).checked).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'เพิ่มพนักงาน' }));
    await user.type(screen.getByLabelText('ชื่อแสดง'), 'คนถัดไป');
    await user.type(screen.getByLabelText('ชื่อเล่น (ใช้เข้าสู่ระบบ)'), 'next');
    await user.type(screen.getByLabelText('รหัสผ่านเริ่มต้น'), 'test-password-123');
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่าน'), 'test-password-123');
    mocks.invoke.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    await user.click(screen.getByRole('button', { name: 'สร้างบัญชีพนักงาน' }));
    await screen.findByRole('alert');
    expect(mocks.invoke.mock.calls[2][1].body.requestId).not.toBe(requestId);
  });
});

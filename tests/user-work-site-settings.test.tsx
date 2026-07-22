import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserEditor } from '../src/features/admin-reference-settings/components/UserEditor';
import type { UserProfile } from '../src/types/app';

const service = vi.hoisted(() => ({
  saveUser: vi.fn(),
  uploadAvatar: vi.fn(),
  removeAvatarFiles: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : 'error',
  saveUserWithWorkSiteAssignments: service.saveUser,
  getUserAvatarSignedUrl: service.getSignedUrl,
  removeUserAvatarFiles: service.removeAvatarFiles,
  uploadUserAvatar: service.uploadAvatar,
}));

const users: UserProfile[] = [
  {
    id: 'employee-1',
    code: 'EMP-01',
    display_name: 'พนักงานหนึ่ง',
    phone: null,
    role: 'courier',
    is_active: true,
  },
  {
    id: 'admin-1',
    code: 'ADMIN-01',
    display_name: 'ผู้ดูแล',
    phone: null,
    role: 'admin',
    is_active: true,
  },
];

const workSites = [
  { id: 'site-a', code: 'SITE-AA', name: 'A · จุดปฏิบัติงาน' },
  { id: 'site-b', code: 'SITE-BB', name: 'B · จุดปฏิบัติงาน' },
];

describe('employee permanent work-site settings', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    service.saveUser.mockReset();
    service.uploadAvatar.mockReset();
    service.removeAvatarFiles.mockReset();
    service.getSignedUrl.mockReset();
    service.getSignedUrl.mockResolvedValue('blob:avatar');
  });

  it('shows current assignments and saves multiple work sites with the user', async () => {
    const user = userEvent.setup();
    const onUserSaved = vi.fn();
    const savedEmployee = { ...users[0], display_name: 'พนักงานหนึ่ง แก้ไข', nickname: 'หนึ่ง' };
    service.saveUser.mockResolvedValue({
      user: savedEmployee,
      work_site_ids: ['site-a', 'site-b'],
    });

    render(
      <UserEditor
        currentUserId="admin-1"
        onUserSaved={onUserSaved}
        users={users}
        workSiteAssignments={[{ user_id: 'employee-1', stock_location_id: 'site-a' }]}
        workSites={workSites}
      />,
    );

    expect(screen.getByText('ประจำ A · จุดปฏิบัติงาน')).toBeTruthy();
    const siteA = screen.getByRole('checkbox', { name: /A · จุดปฏิบัติงาน/ }) as HTMLInputElement;
    const siteB = screen.getByRole('checkbox', { name: /B · จุดปฏิบัติงาน/ }) as HTMLInputElement;
    expect(siteA.checked).toBe(true);
    expect(siteB.checked).toBe(false);

    await user.clear(screen.getByRole('textbox', { name: 'ชื่อแสดง' }));
    await user.type(screen.getByRole('textbox', { name: 'ชื่อแสดง' }), 'พนักงานหนึ่ง แก้ไข');
    await user.type(screen.getByRole('textbox', { name: 'ชื่อเล่น' }), 'หนึ่ง');
    await user.click(siteB);
    await user.click(screen.getByRole('button', { name: 'บันทึกผู้ใช้' }));

    expect(service.saveUser).toHaveBeenCalledWith('employee-1', {
      display_name: 'พนักงานหนึ่ง แก้ไข',
      nickname: 'หนึ่ง',
      avatar_path: null,
      phone: null,
      role: 'courier',
      is_active: true,
    }, ['site-a', 'site-b']);
    expect(onUserSaved).toHaveBeenCalledWith(savedEmployee, ['site-a', 'site-b']);
    expect(screen.getByText('บันทึกข้อมูลผู้ใช้และจุดประจำแล้ว')).toBeTruthy();
  });

  it('clears permanent work sites when changing away from the courier role', async () => {
    const user = userEvent.setup();
    service.saveUser.mockResolvedValue({
      user: { ...users[0], role: 'round_lead' },
      work_site_ids: [],
    });

    render(
      <UserEditor
        currentUserId="admin-1"
        onUserSaved={vi.fn()}
        users={users}
        workSiteAssignments={[{ user_id: 'employee-1', stock_location_id: 'site-a' }]}
        workSites={workSites}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'บทบาท' }), 'round_lead');
    expect(screen.getByRole('group', { name: 'จุดปฏิบัติงานประจำ' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'บันทึกผู้ใช้' }));

    expect(service.saveUser).toHaveBeenCalledWith(
      'employee-1',
      expect.objectContaining({ role: 'round_lead', nickname: null, avatar_path: null }),
      [],
    );
  });

  it('uploads a replacement avatar before the single atomic profile save', async () => {
    const user = userEvent.setup();
    const original = { ...users[0], avatar_path: 'users/employee-1/old.png' };
    const saved = { ...original, avatar_path: 'users/employee-1/new.png' };
    service.uploadAvatar.mockResolvedValue('users/employee-1/new.png');
    service.saveUser.mockResolvedValue({ user: saved, work_site_ids: ['site-a'] });
    service.removeAvatarFiles.mockResolvedValue(undefined);

    render(
      <UserEditor
        currentUserId="admin-1"
        onUserSaved={vi.fn()}
        users={[original, users[1]]}
        workSiteAssignments={[{ user_id: 'employee-1', stock_location_id: 'site-a' }]}
        workSites={workSites}
      />,
    );

    const file = new File(['avatar'], 'new.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/รูปพนักงาน/), file);
    await user.click(screen.getByRole('button', { name: 'บันทึกผู้ใช้' }));

    expect(service.uploadAvatar).toHaveBeenCalledWith('employee-1', file);
    expect(service.saveUser).toHaveBeenCalledWith(
      'employee-1',
      expect.objectContaining({ avatar_path: 'users/employee-1/new.png' }),
      ['site-a'],
    );
    expect(service.uploadAvatar.mock.invocationCallOrder[0]).toBeLessThan(service.saveUser.mock.invocationCallOrder[0]);
    expect(service.removeAvatarFiles).toHaveBeenCalledWith(['users/employee-1/old.png']);
  });
});

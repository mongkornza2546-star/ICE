import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserEditor } from '../src/features/admin-reference-settings/components/UserEditor';
import type { UserProfile } from '../src/types/app';

const service = vi.hoisted(() => ({
  saveUser: vi.fn(),
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : 'error',
  saveUserWithWorkSiteAssignments: service.saveUser,
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
    service.saveUser.mockReset();
  });

  it('shows current assignments and saves multiple work sites with the user', async () => {
    const user = userEvent.setup();
    const onUserSaved = vi.fn();
    const savedEmployee = { ...users[0], display_name: 'พนักงานหนึ่ง แก้ไข' };
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
    await user.click(siteB);
    await user.click(screen.getByRole('button', { name: 'บันทึกผู้ใช้' }));

    expect(service.saveUser).toHaveBeenCalledWith('employee-1', {
      display_name: 'พนักงานหนึ่ง แก้ไข',
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
      expect.objectContaining({ role: 'round_lead' }),
      [],
    );
  });
});

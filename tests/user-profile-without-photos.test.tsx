import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../src/types/app';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), storageFrom: vi.fn(), invoke: vi.fn() }));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
    functions: { invoke: mocks.invoke },
  },
}));

import { UserEditor } from '../src/features/admin-reference-settings/components/UserEditor';

const employee: UserProfile = {
  id: 'employee-1',
  code: 'EMP-001',
  display_name: 'พนักงานทดสอบ',
  nickname: 'test',
  avatar_path: 'users/employee-1/r2/avatar.webp',
  phone: null,
  role: 'courier',
  is_active: true,
  can_collect_shop_payments: false,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('user profiles without employee photos', () => {
  it('shows initials and removes all photo controls even for an existing photo', () => {
    const { container } = render(
      <UserEditor currentUserId="admin-1" onUserSaved={vi.fn()} users={[employee]} workSiteAssignments={[]} workSites={[]} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText('รูปพนักงาน (ไม่บังคับ)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ลบรูปพนักงาน' })).toBeNull();
    expect(screen.getByText('T')).toBeTruthy();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([employee.avatar_path, null])('preserves the stored photo reference %s through the real save service', async (avatarPath) => {
    const user = userEvent.setup();
    const onUserSaved = vi.fn();
    const original = { ...employee, avatar_path: avatarPath };
    const savedEmployee = { ...original, display_name: 'ชื่อใหม่' };
    mocks.rpc.mockImplementation(async (_name, params) => ({
      data: { user: { ...original, display_name: params.p_display_name, avatar_path: params.p_avatar_path }, work_site_ids: [] },
      error: null,
    }));
    render(
      <UserEditor currentUserId="admin-1" onUserSaved={onUserSaved} users={[original]} workSiteAssignments={[]} workSites={[]} />,
    );

    await user.clear(screen.getByLabelText('ชื่อแสดง'));
    await user.type(screen.getByLabelText('ชื่อแสดง'), 'ชื่อใหม่');
    await user.click(screen.getByRole('button', { name: 'บันทึกผู้ใช้' }));
    await waitFor(() => expect(onUserSaved).toHaveBeenCalledWith(savedEmployee, []));
    expect(mocks.rpc).toHaveBeenCalledWith('save_user_profile_with_work_site_assignments_v2', expect.objectContaining({
      p_user_id: employee.id, p_display_name: 'ชื่อใหม่', p_avatar_path: avatarPath,
    }));
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    expect((screen.getByLabelText('ชื่อแสดง') as HTMLInputElement).value).toBe(employee.display_name);
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

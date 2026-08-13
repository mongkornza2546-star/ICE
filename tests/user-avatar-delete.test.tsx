import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../src/types/app';

const mocks = vi.hoisted(() => ({
  getUserAvatarSignedUrl: vi.fn(),
  removeUserAvatarFiles: vi.fn(),
  saveUserWithWorkSiteAssignments: vi.fn(),
  updateUserAvatarPath: vi.fn(),
}));

vi.mock('../src/features/admin-reference-settings/adminReferenceSettingsService', () => ({
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : 'เกิดข้อผิดพลาด',
  getUserAvatarSignedUrl: mocks.getUserAvatarSignedUrl,
  removeUserAvatarFiles: mocks.removeUserAvatarFiles,
  resetUserPassword: vi.fn(),
  saveUserWithWorkSiteAssignments: mocks.saveUserWithWorkSiteAssignments,
  updateUserAvatarPath: mocks.updateUserAvatarPath,
  uploadUserAvatar: vi.fn(),
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
};

describe('user avatar deletion', () => {
  it('removes the avatar reference and stored file immediately', async () => {
    const user = userEvent.setup();
    const onUserSaved = vi.fn();
    const savedEmployee = { ...employee, avatar_path: null };
    mocks.getUserAvatarSignedUrl.mockResolvedValue('https://example.com/avatar.webp');
    mocks.removeUserAvatarFiles.mockResolvedValue(undefined);
    mocks.updateUserAvatarPath.mockResolvedValue(savedEmployee);

    render(
      <UserEditor
        currentUserId="admin-1"
        onUserSaved={onUserSaved}
        users={[employee]}
        workSiteAssignments={[]}
        workSites={[]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'ลบรูปพนักงาน' }));

    await waitFor(() => {
      expect(mocks.updateUserAvatarPath).toHaveBeenCalledWith(employee.id, null);
      expect(mocks.removeUserAvatarFiles).toHaveBeenCalledWith([employee.avatar_path]);
      expect(onUserSaved).toHaveBeenCalledWith(savedEmployee, []);
      expect(screen.getByText('ลบรูปพนักงานแล้ว')).toBeTruthy();
    });
    expect(mocks.saveUserWithWorkSiteAssignments).not.toHaveBeenCalled();
  });

  it('does not restore the deleted avatar when the form is cancelled', async () => {
    const user = userEvent.setup();
    const savedEmployee = { ...employee, avatar_path: null };
    mocks.getUserAvatarSignedUrl.mockResolvedValue('https://example.com/avatar.webp');
    mocks.removeUserAvatarFiles.mockResolvedValue(undefined);
    mocks.updateUserAvatarPath.mockResolvedValue(savedEmployee);

    render(
      <UserEditor
        currentUserId="admin-1"
        onUserSaved={vi.fn()}
        users={[employee]}
        workSiteAssignments={[]}
        workSites={[]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'ลบรูปพนักงาน' }));
    await waitFor(() => expect(mocks.updateUserAvatarPath).toHaveBeenCalledWith(employee.id, null));
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));

    expect(screen.queryByRole('button', { name: 'ลบรูปพนักงาน' })).toBeNull();
    expect(mocks.saveUserWithWorkSiteAssignments).not.toHaveBeenCalled();
    expect(mocks.removeUserAvatarFiles).toHaveBeenCalledWith([employee.avatar_path]);
  });
});

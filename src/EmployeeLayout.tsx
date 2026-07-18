import type { ReactNode } from 'react';
import { SignOut, UserCircle } from '@phosphor-icons/react';
import iceCubeLogo from './assets/ice-cube-cluster-logo.png';

export function EmployeeLayout({
  profileLabel,
  onSignOut,
  signOutDisabled = false,
  children,
}: {
  profileLabel: string;
  onSignOut?: () => void;
  signOutDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="employee-shell">
      <header className="employee-header">
        <div className="employee-brand">
          <img alt="" aria-hidden="true" src={iceCubeLogo} />
          <span>
            <strong>ส่งน้ำแข็ง</strong>
            <small>หน้าพนักงาน</small>
          </span>
        </div>
        <div className="employee-profile">
          <UserCircle aria-hidden="true" size={30} weight="fill" />
          <span>{profileLabel}</span>
          {onSignOut ? (
            <button aria-label="ออกจากระบบ" disabled={signOutDisabled} onClick={onSignOut} title={signOutDisabled ? 'กำลังบันทึกรายการ' : 'ออกจากระบบ'} type="button">
              <SignOut aria-hidden="true" size={20} />
            </button>
          ) : null}
        </div>
      </header>
      <main className="employee-main">{children}</main>
    </div>
  );
}

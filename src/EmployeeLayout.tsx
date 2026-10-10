import type { ReactNode } from 'react';
import { SignOut, UserCircle } from '@phosphor-icons/react';
import iceCubeLogo from './assets/ice-cube-cluster-logo.png';
import { LanguageSwitcher, useLanguage } from './i18n';

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
  const { t } = useLanguage();
  return (
    <div className="employee-shell">
      <header className="employee-header">
        <div className="employee-brand">
          <img alt="" aria-hidden="true" src={iceCubeLogo} />
          <span>
            <strong>{t('brand')}</strong>
            <small>{t('employeePage')}</small>
          </span>
        </div>
        <div className="employee-profile">
          <LanguageSwitcher />
          <UserCircle aria-hidden="true" size={30} weight="fill" />
          <span>{profileLabel}</span>
          {onSignOut ? (
            <button aria-label={t('signOut')} disabled={signOutDisabled} onClick={onSignOut} title={signOutDisabled ? t('saveInProgress') : t('signOut')} type="button">
              <SignOut aria-hidden="true" size={20} />
            </button>
          ) : null}
        </div>
      </header>
      <main className="employee-main">{children}</main>
    </div>
  );
}

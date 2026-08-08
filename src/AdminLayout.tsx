import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ClipboardText,
  Bell,
  CalendarBlank,
  CaretDown,
  ClockCounterClockwise,
  Gear,
  IdentificationCard,
  List,
  MapPin,
  SignOut,
  Storefront,
  ShoppingCart,
  Coins,
  Truck,
  UserCircle,
} from '@phosphor-icons/react';
import iceCubeLogo from './assets/ice-cube-cluster-logo.png';
import { toBangkokDateString } from './lib/serviceDate';

export type AdminView =
  | 'manager_overview'
  | 'factory_order'
  | 'delivery'
  | 'financial_operations'
  | 'stock_operations'
  | 'stock_audit'
  | 'location_management'
  | 'shops'
  | 'reference_settings';

export type FinancialPage = 'collection' | 'transactions' | 'credit' | 'refund';

const viewMeta: Record<AdminView, { label: string; shortLabel: string; icon: typeof Truck }> = {
  manager_overview: { label: 'งานวันนี้', shortLabel: 'งานวันนี้', icon: ClipboardText },
  factory_order: { label: 'สั่งน้ำแข็งจากโรงงาน', shortLabel: 'สั่งน้ำแข็ง', icon: ShoppingCart },
  delivery: { label: 'บันทึกส่งน้ำแข็ง', shortLabel: 'บันทึกส่ง', icon: Truck },
  financial_operations: { label: 'การเงินและบัญชี', shortLabel: 'การเงิน', icon: Coins },
  stock_operations: { label: 'โอน / ตรวจ / ปิดสต๊อก', shortLabel: 'จัดการสต๊อก', icon: MapPin },
  stock_audit: { label: 'Audit สต็อก', shortLabel: 'Audit สต็อก', icon: ClockCounterClockwise },
  location_management: { label: 'สถานที่และจุดถือครอง', shortLabel: 'สถานที่', icon: Gear },
  shops: { label: 'ร้านค้า', shortLabel: 'ร้านค้า', icon: Storefront },
  reference_settings: { label: 'ผู้ใช้และชนิดน้ำแข็ง', shortLabel: 'ข้อมูลระบบ', icon: IdentificationCard },
};


export function AdminLayout({
  activeView,
  allowedViews,
  profileLabel,
  onNavigate,
  financialPage = 'collection',
  onFinancialPageChange,
  serviceDate,
  onServiceDateChange,
  onSignOut,
  signOutDisabled = false,
  children,
}: {
  activeView: AdminView;
  allowedViews: AdminView[];
  profileLabel: string;
  onNavigate: (view: AdminView) => void;
  financialPage?: FinancialPage;
  onFinancialPageChange?: (page: FinancialPage) => void;
  serviceDate?: string;
  onServiceDateChange?: (serviceDate: string) => void;
  onSignOut?: () => void;
  signOutDisabled?: boolean;
  children: ReactNode;
}) {
  const [isDesktopLayout, setIsDesktopLayout] = useState(() => window.innerWidth >= 901);
  const [navigationExpanded, setNavigationExpanded] = useState(() => window.innerWidth >= 901);
  const [financialNavigationExpanded, setFinancialNavigationExpanded] = useState(activeView === 'financial_operations');
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const todayServiceDate = toBangkokDateString();
  const displayedServiceDate = serviceDate ?? todayServiceDate;
  const displayedDate = new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${displayedServiceDate}T12:00:00+07:00`));

  useEffect(() => {
    const handleLayoutChange = () => {
      const nextIsDesktop = window.innerWidth >= 901;
      setIsDesktopLayout(nextIsDesktop);
      setNavigationExpanded(nextIsDesktop);
    };
    window.addEventListener('resize', handleLayoutChange);
    return () => window.removeEventListener('resize', handleLayoutChange);
  }, []);

  useEffect(() => {
    if (!navigationExpanded || isDesktopLayout) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setNavigationExpanded(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isDesktopLayout, navigationExpanded]);

  useEffect(() => {
    if (activeView === 'financial_operations') setFinancialNavigationExpanded(true);
  }, [activeView]);

  const profileInitial = profileLabel.trim().charAt(0).toLocaleUpperCase() || 'U';

  return (
    <div className={`admin-shell ${activeView === 'reference_settings' ? 'admin-shell--reference-settings' : ''} ${activeView === 'shops' ? 'admin-shell--shops' : ''} ${navigationExpanded ? '' : 'admin-shell--sidebar-collapsed'}`}>
      <aside className={`admin-sidebar ${navigationExpanded ? 'admin-sidebar--open' : ''}`} id="admin-navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <img alt="" src={iceCubeLogo} />
          </span>
          <span>
            <strong>ระบบจัดส่งน้ำแข็ง</strong>
            <small>ศูนย์ราชการ</small>
          </span>
        </div>

        <nav className="admin-nav" aria-label="เมนูหัวหน้า">
          {allowedViews.map((view) => {
            const Icon = viewMeta[view].icon;
            if (view === 'financial_operations') {
              return (
                <div className="admin-nav__group" key={view}>
                  <button
                    aria-expanded={financialNavigationExpanded}
                    className={`admin-nav__item ${activeView === view ? 'admin-nav__item--active' : ''}`}
                    onClick={() => {
                      if (activeView !== view) {
                        onNavigate(view);
                        onFinancialPageChange?.('collection');
                        setFinancialNavigationExpanded(true);
                        return;
                      }
                      setFinancialNavigationExpanded((expanded) => !expanded);
                    }}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={21} weight={activeView === view ? 'fill' : 'regular'} />
                    <span>{viewMeta[view].label}</span>
                    <CaretDown aria-hidden="true" className="admin-nav__group-caret" size={15} />
                  </button>
                  {financialNavigationExpanded ? (
                    <div className="admin-nav__subnav" aria-label="เมนูย่อยการเงินและบัญชี">
                      <button
                        aria-current={activeView === view && financialPage === 'collection' ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(view);
                          onFinancialPageChange?.('collection');
                          if (!isDesktopLayout) setNavigationExpanded(false);
                        }}
                        type="button"
                      >เก็บเงินร้านค้า</button>
                      <button
                        aria-current={activeView === view && financialPage === 'transactions' ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(view);
                          onFinancialPageChange?.('transactions');
                          if (!isDesktopLayout) setNavigationExpanded(false);
                        }}
                        type="button"
                      >บัญชี / รายการธุรกรรม</button>
                      <button
                        aria-current={activeView === view && financialPage === 'credit' ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(view);
                          onFinancialPageChange?.('credit');
                          if (!isDesktopLayout) setNavigationExpanded(false);
                        }}
                        type="button"
                      >ลูกหนี้เครดิต</button>
                      <button
                        aria-current={activeView === view && financialPage === 'refund' ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(view);
                          onFinancialPageChange?.('refund');
                          if (!isDesktopLayout) setNavigationExpanded(false);
                        }}
                        type="button"
                      >คิวคืนเงิน</button>
                    </div>
                  ) : null}
                </div>
              );
            }
            return (
              <button
                className={`admin-nav__item ${activeView === view ? 'admin-nav__item--active' : ''}`}
                key={view}
                onClick={() => {
                  onNavigate(view);
                  if (!isDesktopLayout) setNavigationExpanded(false);
                }}
                type="button"
              >
                <Icon aria-hidden="true" size={21} weight={activeView === view ? 'fill' : 'regular'} />
                <span>{viewMeta[view].label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <span className="online-dot" />
          <span>
            <small>สิทธิ์ตามบทบาท</small>
            <strong>ตรวจสอบโดยฐานข้อมูล</strong>
          </span>
        </div>
        <p className="sidebar-version">Ice Delivery · v1.0</p>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar__context">
            <button
              aria-controls="admin-navigation"
              aria-expanded={navigationExpanded}
              className="mobile-menu-button"
              onClick={() => setNavigationExpanded((expanded) => !expanded)}
              ref={menuButtonRef}
              type="button"
            >
              <List size={22} />
              <span>เมนู</span>
            </button>
            {onServiceDateChange ? (
              <label className="context-pill context-pill--date-select">
                <CalendarBlank aria-hidden="true" size={18} />
                <span className="sr-only">วันที่ออกบิล</span>
                <input
                  aria-label="วันที่ออกบิล"
                  max={todayServiceDate}
                  onChange={(event) => {
                    if (event.target.value && event.target.value <= todayServiceDate) {
                      onServiceDateChange(event.target.value);
                    }
                  }}
                  type="date"
                  value={displayedServiceDate}
                />
              </label>
            ) : (
              <span className="context-pill"><CalendarBlank size={18} />{displayedDate}<CaretDown size={14} /></span>
            )}
            <span className="context-pill"><MapPin size={18} />ศูนย์ราชการ<CaretDown size={14} /></span>
          </div>
          <div className="admin-topbar__actions">
            <span className="current-view-label">{viewMeta[activeView].shortLabel}</span>
            {activeView === 'reference_settings' || activeView === 'shops' ? (
              <>
                <button aria-label="การแจ้งเตือน" className="topbar-notification" type="button">
                  <Bell size={21} weight="regular" />
                </button>
                <span className="topbar-profile-divider" aria-hidden="true" />
              </>
            ) : null}
            <div className="profile-menu">
              {activeView === 'shops' ? <span aria-hidden="true" className="profile-menu__initial">{profileInitial}</span> : <UserCircle size={30} weight="fill" />}
              <span>{profileLabel}</span>
              {!onSignOut ? <CaretDown size={16} /> : null}
            </div>
            {onSignOut ? (
              <button aria-label="ออกจากระบบ" className="sign-out-button" disabled={signOutDisabled} onClick={onSignOut} title={signOutDisabled ? 'กำลังบันทึกรายการ' : 'ออกจากระบบ'} type="button">
                <SignOut size={18} />
              </button>
            ) : null}
          </div>
        </header>
        <main className="admin-content">{children}</main>
      </div>
      {navigationExpanded && !isDesktopLayout ? <button className="sidebar-scrim" aria-label="ปิดเมนู" onClick={() => setNavigationExpanded(false)} type="button" /> : null}
    </div>
  );
}

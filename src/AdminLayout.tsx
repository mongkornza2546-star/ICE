import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Buildings,
  ClipboardText,
  CalendarBlank,
  CaretDown,
  Gear,
  IdentificationCard,
  List,
  MapPin,
  SignOut,
  Storefront,
  ShoppingCart,
  Truck,
  UserCircle,
} from '@phosphor-icons/react';
import iceCubeLogo from './assets/ice-cube-cluster-logo.png';

export type AdminView =
  | 'manager_overview'
  | 'factory_order'
  | 'manager'
  | 'delivery'
  | 'stock_operations'
  | 'stock_locations'
  | 'locations'
  | 'shops'
  | 'reference_settings';

const viewMeta: Record<AdminView, { label: string; shortLabel: string; icon: typeof Truck }> = {
  manager_overview: { label: 'ภาพรวมงานวันนี้', shortLabel: 'ภาพรวม', icon: ClipboardText },
  factory_order: { label: 'สั่งน้ำแข็งจากโรงงาน', shortLabel: 'สั่งน้ำแข็ง', icon: ShoppingCart },
  manager: { label: 'ควบคุมรอบส่ง', shortLabel: 'ควบคุมรอบ', icon: ClipboardText },
  delivery: { label: 'บันทึกส่งน้ำแข็ง', shortLabel: 'บันทึกส่ง', icon: Truck },
  stock_operations: { label: 'โอน / ตรวจ / ปิดสต๊อก', shortLabel: 'จัดการสต๊อก', icon: MapPin },
  stock_locations: { label: 'ตั้งค่าจุดถือครอง', shortLabel: 'จุดถือครอง', icon: Gear },
  locations: { label: 'ตึกและโซนย่อย', shortLabel: 'ตึกและโซน', icon: Buildings },
  shops: { label: 'ร้านค้า', shortLabel: 'ร้านค้า', icon: Storefront },
  reference_settings: { label: 'ผู้ใช้และชนิดน้ำแข็ง', shortLabel: 'ข้อมูลระบบ', icon: IdentificationCard },
};

export function AdminLayout({
  activeView,
  allowedViews,
  profileLabel,
  onNavigate,
  onSignOut,
  signOutDisabled = false,
  children,
}: {
  activeView: AdminView;
  allowedViews: AdminView[];
  profileLabel: string;
  onNavigate: (view: AdminView) => void;
  onSignOut?: () => void;
  signOutDisabled?: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const today = new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date());

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  return (
    <div className="admin-shell">
      <aside className={`admin-sidebar ${menuOpen ? 'admin-sidebar--open' : ''}`} id="admin-navigation">
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
            return (
              <button
                className={`admin-nav__item ${activeView === view ? 'admin-nav__item--active' : ''}`}
                key={view}
                onClick={() => {
                  onNavigate(view);
                  setMenuOpen(false);
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
              aria-expanded={menuOpen}
              className="mobile-menu-button"
              onClick={() => setMenuOpen((open) => !open)}
              ref={menuButtonRef}
              type="button"
            >
              <List size={22} />
              <span>เมนู</span>
            </button>
            <span className="context-pill"><CalendarBlank size={18} />{today}</span>
            <span className="context-pill"><MapPin size={18} />ศูนย์ราชการ</span>
          </div>
          <div className="admin-topbar__actions">
            <span className="current-view-label">{viewMeta[activeView].shortLabel}</span>
            <div className="profile-menu">
              <UserCircle size={30} weight="fill" />
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
      {menuOpen ? <button className="sidebar-scrim" aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} type="button" /> : null}
    </div>
  );
}

import { useState, type ReactNode } from 'react';
import {
  Buildings,
  CalendarBlank,
  CaretDown,
  Cube,
  List,
  MapPin,
  SignOut,
  Storefront,
  Truck,
  UserCircle,
} from '@phosphor-icons/react';

export type AdminView = 'manager' | 'delivery' | 'stock_locations' | 'locations' | 'shops';

const viewMeta: Record<AdminView, { label: string; shortLabel: string; icon: typeof Truck }> = {
  manager: { label: 'ควบคุมรอบส่ง', shortLabel: 'รอบส่ง', icon: Truck },
  delivery: { label: 'บัตรร้านและบันทึกส่ง', shortLabel: 'บันทึกส่ง', icon: Cube },
  stock_locations: { label: 'จุดถือครองสต๊อก', shortLabel: 'จุดสต๊อก', icon: MapPin },
  locations: { label: 'ตึกและโซนย่อย', shortLabel: 'ตึกและโซน', icon: Buildings },
  shops: { label: 'ร้านค้า', shortLabel: 'ร้านค้า', icon: Storefront },
};

export function AdminLayout({
  activeView,
  allowedViews,
  profileLabel,
  onNavigate,
  onSignOut,
  children,
}: {
  activeView: AdminView;
  allowedViews: AdminView[];
  profileLabel: string;
  onNavigate: (view: AdminView) => void;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const today = new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date());

  return (
    <div className="admin-shell">
      <aside className={`admin-sidebar ${menuOpen ? 'admin-sidebar--open' : ''}`}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Cube weight="duotone" />
            <Truck weight="fill" />
          </span>
          <span>
            <strong>ระบบจัดส่งน้ำแข็ง</strong>
            <small>ศูนย์ราชการ</small>
          </span>
        </div>

        <nav className="admin-nav" aria-label="เมนูแอดมิน">
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
            <small>อัปเดตข้อมูลล่าสุด</small>
            <strong>เมื่อสักครู่</strong>
          </span>
        </div>
        <p className="sidebar-version">Ice Delivery · v1.0</p>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <button className="mobile-menu-button" onClick={() => setMenuOpen((open) => !open)} type="button">
            <List size={22} />
            <span>เมนู</span>
          </button>
          <div className="admin-topbar__title">
            <p>ศูนย์ราชการ</p>
            <h1>{viewMeta[activeView].label}</h1>
          </div>
          <div className="admin-topbar__actions">
            <span className="context-pill"><CalendarBlank size={18} />{today}</span>
            <span className="context-pill"><MapPin size={18} />ศูนย์ราชการ</span>
            <button className="profile-menu" onClick={onSignOut} type="button" title={onSignOut ? 'ออกจากระบบ' : undefined}>
              <UserCircle size={30} weight="fill" />
              <span>{profileLabel}</span>
              {onSignOut ? <SignOut size={17} /> : <CaretDown size={16} />}
            </button>
          </div>
        </header>
        <main className="admin-content">{children}</main>
      </div>
      {menuOpen ? <button className="sidebar-scrim" aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} type="button" /> : null}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { AdminLayout, type AdminView, type FinancialPage } from './AdminLayout';
import { ManagerDashboard } from './ManagerDashboard';
import { FactoryOrderPage } from './FactoryOrderPage';
import { AdminReferenceSettings } from './AdminReferenceSettings';
import { EmployeeLayout } from './EmployeeLayout';
import { EmployeeDeliveryWorkspace } from './EmployeeDeliveryWorkspace';
import { LocationManagementSettings } from './LocationManagementSettings';
import { ShopSettings } from './ShopSettings';
import { RoundWorkspace } from './RoundWorkspace';
import { ManagerStockAudit } from './ManagerStockAudit';
import { FinancialOperations } from './FinancialOperations';
import { Coins, Package, Storefront } from '@phosphor-icons/react';
import type { UserProfile } from './types/app';
import { toBangkokDateString } from './lib/serviceDate';
import { clearNavigation, clearRecoveryForOwner, readNavigation, writeNavigation } from './lib/recoveryStorage';

/**
 * Wrapper that keeps its children mounted once rendered,
 * but hides them with display:none when not active.
 * This preserves component state (fetched data, scroll position, form input)
 * across tab switches without re-mounting / re-fetching.
 */
function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div style={{ display: active ? undefined : 'none' }}>
      {children}
    </div>
  );
}

export function RoleRouter({
  session,
  onRecoverableSessionError,
}: {
  session: Session;
  onRecoverableSessionError: (message: string | null | undefined) => Promise<boolean>;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AdminView>('manager_overview');
  const [financialPage, setFinancialPage] = useState<FinancialPage>('collection');
  const [courierView, setCourierView] = useState<'withdrawal' | 'pos' | 'collection'>('pos');
  const [billingServiceDate, setBillingServiceDate] = useState(() => toBangkokDateString());
  const [currentBangkokDate, setCurrentBangkokDate] = useState(() => toBangkokDateString());
  const [deliveryDraftState, setDeliveryDraftState] = useState({ dirty: false, submitting: false });
  const navigationOwner = useRef<string | null>(null);
  const previousBangkokDate = useRef(currentBangkokDate);
  // Track which views have been visited so we only mount them on first visit
  // (lazy mount) but keep them alive afterwards (no unmount on tab switch).
  const [visitedViews, setVisitedViews] = useState<Set<AdminView>>(() => new Set(['manager_overview']));

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async () => {
      if (!supabase) {
        return;
      }

      setProfileLoading(true);
      setProfileError(null);

      const { data, error } = await supabase
        .from('users')
        .select('id, code, display_name, phone, role, is_active')
        .eq('id', session.user.id)
        .maybeSingle();

      if (cancelled) {
        return;
      }

      if (error) {
        if (await onRecoverableSessionError(error.message)) {
          setProfileLoading(false);
          return;
        }
        setProfileError(error.message);
      } else {
        setProfile(data as UserProfile | null);
      }

      setProfileLoading(false);
    };

    loadProfile();

    return () => {
      cancelled = true;
    };
  }, [onRecoverableSessionError, session.user.id]);

  useEffect(() => {
    if (!profile) return;
    if (navigationOwner.current !== profile.id) {
      const saved = readNavigation(profile.id);
      navigationOwner.current = profile.id;
      setActiveView(saved?.activeView ? saved.activeView as AdminView : 'manager_overview');
      setFinancialPage(saved?.financialPage === 'transactions' || saved?.financialPage === 'credit' || saved?.financialPage === 'refund' ? saved.financialPage : 'collection');
      setCourierView(saved?.courierView ?? 'pos');
      setBillingServiceDate(currentBangkokDate);
      return;
    }
    writeNavigation(profile.id, { activeView, financialPage, courierView, billingServiceDate });
  }, [activeView, billingServiceDate, courierView, currentBangkokDate, financialPage, profile]);

  useEffect(() => {
    const refreshCurrentDate = () => setCurrentBangkokDate(toBangkokDateString());
    const intervalId = window.setInterval(refreshCurrentDate, 60_000);
    window.addEventListener('focus', refreshCurrentDate);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshCurrentDate);
    };
  }, []);

  useEffect(() => {
    if (previousBangkokDate.current === currentBangkokDate) return;
    previousBangkokDate.current = currentBangkokDate;
    setBillingServiceDate(currentBangkokDate);
  }, [currentBangkokDate]);

  useEffect(() => {
    if (!deliveryDraftState.dirty && !deliveryDraftState.submitting) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [deliveryDraftState.dirty, deliveryDraftState.submitting]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ice-delivery-draft-state', {
      detail: { dirty: deliveryDraftState.dirty || deliveryDraftState.submitting },
    }));
  }, [deliveryDraftState.dirty, deliveryDraftState.submitting]);

  const confirmLeavingDelivery = () => {
    if (deliveryDraftState.submitting) return false;
    return !deliveryDraftState.dirty || window.confirm('ยังไม่ได้บันทึกรายการนี้ ต้องการออกจากหน้านี้หรือไม่?');
  };

  const signOut = async () => {
    if (!confirmLeavingDelivery()) return;
    if (profile) {
      clearNavigation(profile.id);
      clearRecoveryForOwner(profile.id);
    }
    await supabase?.auth.signOut();
  };

  if (profileLoading) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">กำลังโหลดสิทธิ์</p>
          <h1>ตรวจข้อมูลผู้ใช้ในระบบ</h1>
        </section>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">โหลดผู้ใช้ไม่สำเร็จ</p>
          <h1>{profileError}</h1>
          <button className="ghost-button" onClick={signOut} type="button">
            ออกจากระบบ
          </button>
        </section>
      </div>
    );
  }

  if (!profile?.is_active) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">บัญชียังไม่พร้อมใช้งาน</p>
          <h1>ผู้ดูแลยังไม่ได้เปิดสิทธิ์บัญชีนี้</h1>
          <p className="muted">
            บัญชี Supabase Auth ถูกสร้างแล้ว แต่ `public.users.is_active` ยังเป็น `false`
          </p>
          <button className="ghost-button" onClick={signOut} type="button">
            ออกจากระบบ
          </button>
        </section>
      </div>
    );
  }

  if (profile.role === 'courier') {
    return (
      <EmployeeLayout onSignOut={signOut} profileLabel={profile.display_name} signOutDisabled={deliveryDraftState.submitting}>
        <nav aria-label="งานพนักงาน" className="employee-task-tabs">
          <button
            aria-current={courierView === 'withdrawal' ? 'page' : undefined}
            onClick={() => {
              if (courierView !== 'withdrawal' && !confirmLeavingDelivery()) return;
              setCourierView('withdrawal');
            }}
            type="button"
          >
            <Package aria-hidden="true" size={22} weight="duotone" />
            <span>เบิก</span>
          </button>
          <button
            aria-current={courierView === 'pos' ? 'page' : undefined}
            onClick={() => {
              if (courierView !== 'pos' && !confirmLeavingDelivery()) return;
              setCourierView('pos');
            }}
            type="button"
          >
            <Storefront aria-hidden="true" size={22} weight="duotone" />
            <span>POS</span>
          </button>
          <button
            aria-current={courierView === 'collection' ? 'page' : undefined}
            disabled={deliveryDraftState.submitting}
            onClick={() => {
              if (courierView !== 'collection' && !confirmLeavingDelivery()) return;
              setCourierView('collection');
            }}
            type="button"
          >
            <Coins aria-hidden="true" size={22} weight="duotone" />
            <span>เก็บเงิน</span>
          </button>
        </nav>
        <KeepAlive active={courierView !== 'collection'}>
          <EmployeeDeliveryWorkspace
            enableAssignedStockFlow={courierView === 'withdrawal'}
            onDraftStateChange={setDeliveryDraftState}
            requestScope={profile.id}
            viewMode={courierView === 'withdrawal' ? 'withdrawal' : 'pos'}
          />
        </KeepAlive>
        <KeepAlive active={courierView === 'collection'}>
          <FinancialOperations currentUserId={profile.id} userRole="courier" />
        </KeepAlive>
      </EmployeeLayout>
    );
  }

  const canManageRounds = profile.role === 'admin' || profile.role === 'round_lead';
  const currentView = canManageRounds ? activeView : 'delivery';

  // Mark the current view as visited (lazy mount)
  if (!visitedViews.has(currentView)) {
    setVisitedViews((prev) => {
      const next = new Set(prev);
      next.add(currentView);
      return next;
    });
  }

  const allowedViews: AdminView[] = canManageRounds
    ? profile.role === 'admin'
      ? [
          'manager_overview',
          'factory_order',
          'delivery',
          'financial_operations',
          'stock_operations',
          'location_management',
          'shops',
          'stock_audit',
          'reference_settings',
        ]
      : [
          'manager_overview',
          'factory_order',
          'delivery',
          'financial_operations',
          'stock_operations',
          'stock_audit',
          'location_management',
        ]
    : ['delivery'];

  const navigate = (view: AdminView) => {
    if (view !== currentView && currentView === 'delivery' && !confirmLeavingDelivery()) return;
    if (view === 'delivery' && currentView !== 'delivery') {
      setBillingServiceDate(currentBangkokDate);
    }
    setActiveView(view);
  };

  const changeBillingServiceDate = (serviceDate: string) => {
    if (serviceDate === billingServiceDate) return;
    if (serviceDate > toBangkokDateString()) return;
    if (!confirmLeavingDelivery()) return;
    setBillingServiceDate(serviceDate);
  };

  return (
    <AdminLayout
      activeView={currentView}
      allowedViews={allowedViews}
      financialPage={financialPage}
      onNavigate={navigate}
      onFinancialPageChange={setFinancialPage}
      onServiceDateChange={profile.role === 'admin' && currentView === 'delivery'
        ? changeBillingServiceDate
        : undefined}
      onSignOut={signOut}
      profileLabel={profile.display_name}
      serviceDate={profile.role === 'admin' && currentView === 'delivery'
        ? billingServiceDate
        : undefined}
      signOutDisabled={deliveryDraftState.submitting}
    >
      {/* Keep-alive views: mount on first visit, stay mounted (hidden) on tab switch */}
      {visitedViews.has('manager_overview') && (
        <KeepAlive active={currentView === 'manager_overview'}>
          <ManagerDashboard
            isActive={currentView === 'manager_overview'}
            onNavigate={setActiveView}
            profileRole={profile.role === 'admin' ? 'admin' : 'round_lead'}
          />
        </KeepAlive>
      )}
      {visitedViews.has('factory_order') && (
        <KeepAlive active={currentView === 'factory_order'}>
          <FactoryOrderPage />
        </KeepAlive>
      )}
      {visitedViews.has('location_management') && (
        <KeepAlive active={currentView === 'location_management'}>
          <LocationManagementSettings canManageBuildings={profile.role === 'admin'} />
        </KeepAlive>
      )}
      {visitedViews.has('shops') && (
        <KeepAlive active={currentView === 'shops'}>
          <ShopSettings isActive={currentView === 'shops'} />
        </KeepAlive>
      )}
      {visitedViews.has('reference_settings') && (
        <KeepAlive active={currentView === 'reference_settings'}>
          <AdminReferenceSettings />
        </KeepAlive>
      )}
      {visitedViews.has('stock_operations') && (
        <KeepAlive active={currentView === 'stock_operations'}>
          <RoundWorkspace isActive={currentView === 'stock_operations'} />
        </KeepAlive>
      )}
      {visitedViews.has('stock_audit') && (
        <KeepAlive active={currentView === 'stock_audit'}>
          <ManagerStockAudit />
        </KeepAlive>
      )}
      {visitedViews.has('delivery') && (
        <KeepAlive active={currentView === 'delivery'}>
          <EmployeeDeliveryWorkspace
            onDraftStateChange={setDeliveryDraftState}
            requestScope={profile.id}
            serviceDate={profile.role === 'admin' ? billingServiceDate : undefined}
            stockSourceLabel="สต๊อกรวมประจำวัน"
          />
        </KeepAlive>
      )}
      {visitedViews.has('financial_operations') && (
        <KeepAlive active={currentView === 'financial_operations'}>
          <FinancialOperations managerPage={financialPage} onManagerPageChange={setFinancialPage} userRole={profile.role} />
        </KeepAlive>
      )}
    </AdminLayout>
  );

}

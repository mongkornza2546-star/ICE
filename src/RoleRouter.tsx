import { useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { AdminLayout, type AdminView } from './AdminLayout';
import { ManagerDashboard } from './ManagerDashboard';
import { FactoryOrderPage } from './FactoryOrderPage';
import { AdminReferenceSettings } from './AdminReferenceSettings';
import { EmployeeLayout } from './EmployeeLayout';
import { EmployeeDeliveryWorkspace } from './EmployeeDeliveryWorkspace';
import { LocationSettings } from './LocationSettings';
import { StockLocationSettings } from './StockLocationSettings';
import { ShopSettings } from './ShopSettings';
import { RoundWorkspace } from './RoundWorkspace';
import type { UserProfile } from './types/app';

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
  const [deliveryDraftState, setDeliveryDraftState] = useState({ dirty: false, submitting: false });

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
    if (!deliveryDraftState.dirty && !deliveryDraftState.submitting) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [deliveryDraftState.dirty, deliveryDraftState.submitting]);

  const confirmLeavingDelivery = () => {
    if (deliveryDraftState.submitting) return false;
    return !deliveryDraftState.dirty || window.confirm('ยังไม่ได้บันทึกรายการนี้ ต้องการออกจากหน้านี้หรือไม่?');
  };

  const signOut = async () => {
    if (!confirmLeavingDelivery()) return;
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
        <EmployeeDeliveryWorkspace enableAssignedStockFlow onDraftStateChange={setDeliveryDraftState} requestScope={profile.id} />
      </EmployeeLayout>
    );
  }

  const canManageRounds = profile.role === 'admin' || profile.role === 'round_lead';
  const currentView = canManageRounds ? activeView : 'delivery';

  const allowedViews: AdminView[] = canManageRounds
    ? profile.role === 'admin'
      ? [
          'manager_overview',
          'factory_order',
          'manager',
          'delivery',
          'stock_operations',
          'stock_locations',
          'locations',
          'shops',
          'reference_settings',
        ]
      : [
          'manager_overview',
          'factory_order',
          'manager',
          'delivery',
          'stock_operations',
          'stock_locations',
        ]
    : ['delivery'];

  const navigate = (view: AdminView) => {
    if (view !== currentView && currentView === 'delivery' && !confirmLeavingDelivery()) return;
    setActiveView(view);
  };

  return (
    <AdminLayout
      activeView={currentView}
      allowedViews={allowedViews}
      onNavigate={navigate}
      onSignOut={signOut}
      profileLabel={profile.display_name}
      signOutDisabled={deliveryDraftState.submitting}
    >
      {currentView === 'manager_overview' ? (
        <ManagerDashboard
          onNavigate={setActiveView}
          profileRole={profile.role === 'admin' ? 'admin' : 'round_lead'}
        />
      ) : currentView === 'factory_order' ? (
        <FactoryOrderPage />
      ) : currentView === 'locations' ? (
        <LocationSettings />
      ) : currentView === 'stock_locations' ? (
        <StockLocationSettings />
      ) : currentView === 'shops' ? (
        <ShopSettings />
      ) : currentView === 'reference_settings' ? (
        <AdminReferenceSettings />
      ) : currentView === 'stock_operations' ? (
        <RoundWorkspace mode="stock" profile={profile} />
      ) : currentView === 'delivery' ? (
        <EmployeeDeliveryWorkspace onDraftStateChange={setDeliveryDraftState} requestScope={profile.id} stockSourceLabel="จุดสต๊อกของร้าน" />
      ) : (
        <RoundWorkspace mode="manager" profile={profile} />
      )}
    </AdminLayout>
  );
}

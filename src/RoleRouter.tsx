import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { AdminLayout, type AdminView, type FinancialPage } from './AdminLayout';
import { ManagerDashboard } from './ManagerDashboard';
import { ExecutiveReportsPage } from './features/reports/ExecutiveReportsPage';
import { FactoryOrderPage } from './FactoryOrderPage';
import { AdminReferenceSettings } from './AdminReferenceSettings';
import { EmployeeLayout } from './EmployeeLayout';
import { EmployeeDeliveryWorkspace } from './EmployeeDeliveryWorkspace';
import { LocationManagementSettings } from './LocationManagementSettings';
import { ShopSettings } from './ShopSettings';
import { RoundWorkspace } from './RoundWorkspace';
import { ManagerStockAudit } from './ManagerStockAudit';
import { FinancialOperations } from './FinancialOperations';
import { EventManagementPage } from './EventManagementPage';
import { EmployeeEventPage } from './EmployeeEventPage';
import { CalendarBlank, Coins, Package, Storefront } from '@phosphor-icons/react';
import type { CollectionCloseResult, CollectionFocusRequest, UserProfile } from './types/app';
import { toBangkokDateString } from './lib/serviceDate';
import { clearNavigation, clearRecoveryForOwner, readNavigation, writeNavigation } from './lib/recoveryStorage';
import {
  clearCachedUserProfile,
  readCachedUserProfile,
  USER_PROFILE_REVALIDATE_MS,
  writeCachedUserProfile,
} from './lib/userProfileCache';
import { COLLECTION_PROFILE_REFRESH_EVENT } from './lib/collectionContext';
import { initGlobalRealtimeSync } from './lib/realtimeSync';
import { clearPosCollectionReturn, readPosCollectionReturn } from './lib/posCollectionReturn';

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

export function canUserProfileCollectPayments(
  profile: Pick<UserProfile, 'role' | 'can_collect_shop_payments'> | null | undefined,
): boolean {
  if (!profile) return false;
  if (profile.role === 'admin' || profile.role === 'round_lead') return true;
  return Boolean(profile.can_collect_shop_payments);
}

export function RoleRouter({
  session,
  onRecoverableSessionError,
}: {
  session: Session;
  onRecoverableSessionError: (message: string | null | undefined) => Promise<boolean>;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profilePreview, setProfilePreview] = useState<UserProfile | null>(() => (
    readCachedUserProfile(session.user.id)?.profile ?? null
  ));
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AdminView>('manager_overview');
  const [financialPage, setFinancialPage] = useState<FinancialPage>('collection');
  const [courierView, setCourierView] = useState<'withdrawal' | 'pos' | 'events' | 'collection'>('pos');
  const [courierCollectionFocus, setCourierCollectionFocus] = useState<CollectionFocusRequest | null>(null);
  const [courierCollectionVisited, setCourierCollectionVisited] = useState(false);
  const [adminCollectionFocus, setAdminCollectionFocus] = useState<CollectionFocusRequest | null>(null);
  const [focusedCollectionServiceDate, setFocusedCollectionServiceDate] = useState<string | null>(null);
  const [collectionCloseResult, setCollectionCloseResult] = useState<CollectionCloseResult | null>(null);
  const [billingServiceDate, setBillingServiceDate] = useState(() => toBangkokDateString());
  const [selectedEventJobId, setSelectedEventJobId] = useState<string | null>(null);
  const [currentBangkokDate, setCurrentBangkokDate] = useState(() => toBangkokDateString());
  const [deliveryDraftState, setDeliveryDraftState] = useState({ dirty: false, submitting: false });
  const navigationOwner = useRef<string | null>(null);
  const [navigationReadyOwner, setNavigationReadyOwner] = useState<string | null>(null);
  const previousBangkokDate = useRef(currentBangkokDate);
  // Track which views have been visited so we only mount them on first visit
  // (lazy mount) but keep them alive afterwards (no unmount on tab switch).
  const [visitedViews, setVisitedViews] = useState<Set<AdminView>>(() => new Set(['manager_overview']));

  useEffect(() => {
    let cancelled = false;
    let request: Promise<void> | null = null;
    const cached = readCachedUserProfile(session.user.id);
    let hasValidatedProfile = false;
    let validatedAt = 0;

    setProfile(null);
    setProfilePreview(cached?.profile ?? null);
    setProfileLoading(true);
    setProfileError(null);

    const loadProfile = (force = false) => {
      if (!force && Date.now() - validatedAt < USER_PROFILE_REVALIDATE_MS) return Promise.resolve();
      if (request) return request;
      if (!supabase) {
        setProfileLoading(false);
        return Promise.resolve();
      }

      request = (async () => {
        const { data, error } = await supabase
          .from('users')
          .select('id, code, display_name, phone, role, is_active, can_collect_shop_payments')
          .eq('id', session.user.id)
          .maybeSingle();

        if (cancelled) return;
        if (error) {
          if (await onRecoverableSessionError(error.message)) {
            setProfileLoading(false);
            return;
          }
          if (!hasValidatedProfile) setProfileError(error.message);
          setProfileLoading(false);
          return;
        }

        const nextProfile = data as UserProfile | null;
        validatedAt = Date.now();
        hasValidatedProfile = Boolean(nextProfile);
        setProfile(nextProfile);
        setProfilePreview(nextProfile);
        setProfileError(null);
        setProfileLoading(false);
        if (nextProfile) writeCachedUserProfile(nextProfile, validatedAt);
        else clearCachedUserProfile(session.user.id);
      })().finally(() => {
        request = null;
      });
      return request;
    };

    void loadProfile(true);
    const refreshOnFocus = () => { void loadProfile(); };
    const refreshAfterAuthorizationFailure = () => { void loadProfile(true); };
    const refreshInterval = window.setInterval(() => { void loadProfile(); }, USER_PROFILE_REVALIDATE_MS);
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener(COLLECTION_PROFILE_REFRESH_EVENT, refreshAfterAuthorizationFailure);

    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener(COLLECTION_PROFILE_REFRESH_EVENT, refreshAfterAuthorizationFailure);
    };
  }, [onRecoverableSessionError, session.user.id]);

  useEffect(() => {
    if (!profile) return;
    if (navigationOwner.current !== profile.id) {
      const saved = readNavigation(profile.id);
      const returnContext = readPosCollectionReturn(profile.id);
      navigationOwner.current = profile.id;
      setNavigationReadyOwner(profile.id);
      if (returnContext) {
        setBillingServiceDate(returnContext.posServiceDate);
        setFocusedCollectionServiceDate(returnContext.collectionServiceDate);
        if (profile.role === 'courier') {
          setCourierCollectionFocus(returnContext.request);
          setCourierCollectionVisited(true);
          setCourierView('collection');
        } else {
          setAdminCollectionFocus(returnContext.request);
          setVisitedViews((views) => new Set([...views, 'delivery', 'financial_operations']));
          setFinancialPage('collection');
          setActiveView('financial_operations');
        }
        return;
      }
      setActiveView(saved?.activeView && (saved.activeView !== 'executive_reports' || profile.role === 'admin')
        ? saved.activeView as AdminView : 'manager_overview');
      setFinancialPage(saved?.financialPage === 'transactions' || saved?.financialPage === 'credit' ? saved.financialPage : 'collection');
      setCourierView(saved?.courierView ?? 'pos');
      setSelectedEventJobId(saved?.eventJobId ?? null);
      setBillingServiceDate(currentBangkokDate);
      return;
    }
    writeNavigation(profile.id, {
      activeView,
      financialPage,
      courierView,
      billingServiceDate,
      eventJobId: selectedEventJobId,
    });
  }, [activeView, billingServiceDate, courierView, currentBangkokDate, financialPage, profile, selectedEventJobId]);

  useEffect(() => {
    if (courierView === 'collection') setCourierCollectionVisited(true);
  }, [courierView]);

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
    return initGlobalRealtimeSync();
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
      clearPosCollectionReturn(profile.id);
      clearNavigation(profile.id);
      clearRecoveryForOwner(profile.id);
      clearCachedUserProfile(profile.id);
    }
    await supabase?.auth.signOut();
  };

  if (profileLoading || (profile && navigationReadyOwner !== profile.id)) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">กำลังโหลดสิทธิ์</p>
          <h1>ตรวจข้อมูลผู้ใช้ในระบบ</h1>
          {profilePreview ? <p className="muted">{profilePreview.display_name}</p> : null}
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

  const canCollectPayments = canUserProfileCollectPayments(profile);

  if (profile.role === 'courier') {
    return (
      <EmployeeLayout onSignOut={signOut} profileLabel={profile.display_name} signOutDisabled={deliveryDraftState.submitting}>
        <nav aria-label="งานพนักงาน" className="employee-task-tabs">
          <button
            aria-current={courierView === 'withdrawal' ? 'page' : undefined}
            onClick={() => {
              if (courierView !== 'withdrawal' && !confirmLeavingDelivery()) return;
              clearPosCollectionReturn(profile.id);
              setCourierCollectionFocus(null);
              setCourierView('withdrawal');
            }}
            type="button"
          >
            <Package aria-hidden="true" size={22} weight="duotone" />
            <span>เติม / คืน / ละลาย</span>
          </button>
          <button
            aria-current={courierView === 'pos' ? 'page' : undefined}
            onClick={() => {
              if (courierView !== 'pos' && !confirmLeavingDelivery()) return;
              clearPosCollectionReturn(profile.id);
              setCourierCollectionFocus(null);
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
              clearPosCollectionReturn(profile.id);
              setCourierCollectionFocus(null);
              setCourierCollectionVisited(true);
              setCourierView('collection');
            }}
            type="button"
          >
            <Coins aria-hidden="true" size={22} weight="duotone" />
            <span>เก็บเงิน</span>
          </button>
          <button
            aria-current={courierView === 'events' ? 'page' : undefined}
            disabled={deliveryDraftState.submitting}
            onClick={() => {
              if (courierView !== 'events' && !confirmLeavingDelivery()) return;
              clearPosCollectionReturn(profile.id);
              setCourierCollectionFocus(null);
              setCourierView('events');
            }}
            type="button"
          >
            <CalendarBlank aria-hidden="true" size={22} weight="duotone" />
            <span>อีเวนต์</span>
          </button>
        </nav>
        <KeepAlive active={courierView === 'withdrawal' || courierView === 'pos'}>
          <EmployeeDeliveryWorkspace
            casualCustomerEnabled
            canCollectShopPayments={canCollectPayments}
            enableAssignedStockFlow={courierView === 'withdrawal'}
            isActive={courierView === 'withdrawal' || courierView === 'pos'}
            onDraftStateChange={setDeliveryDraftState}
            onOpenCollection={(request) => {
              setCollectionCloseResult(null);
              setCourierCollectionFocus(request);
              setFocusedCollectionServiceDate(currentBangkokDate);
              setCourierCollectionVisited(true);
              setCourierView('collection');
            }}
            onOpenEvents={() => setCourierView('events')}
            requestScope={profile.id}
            collectionReturnOrigin="courier-pos"
            collectionCloseResult={collectionCloseResult}
            viewMode={courierView === 'withdrawal' ? 'withdrawal' : 'pos'}
          />
        </KeepAlive>
        <KeepAlive active={courierView === 'events'}>
          <EmployeeEventPage isActive={courierView === 'events'} />
        </KeepAlive>
        {courierCollectionVisited || courierView === 'collection' ? (
          <KeepAlive active={courierView === 'collection'}>
            <FinancialOperations
              canCollectShopPayments={canCollectPayments}
              currentUserId={profile.id}
              focusRequest={courierCollectionFocus}
              isActive={courierView === 'collection'}
              onFocusedCollectionClose={(result) => {
                setCollectionCloseResult(result);
                setCourierCollectionFocus(null);
                setFocusedCollectionServiceDate(null);
                setCourierView('pos');
              }}
              serviceDate={focusedCollectionServiceDate ?? undefined}
              userRole="courier"
            />
          </KeepAlive>
        ) : null}
      </EmployeeLayout>
    );
  }

  const canManageRounds = profile.role === 'admin' || profile.role === 'round_lead';
  const currentView = canManageRounds
    ? (activeView === 'executive_reports' && profile.role !== 'admin' ? 'manager_overview' : activeView)
    : 'delivery';

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
          'executive_reports',
          'events',
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
          'events',
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
    if (view !== 'financial_operations') {
      clearPosCollectionReturn(profile.id);
      setAdminCollectionFocus(null);
    }
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

  const changeFinancialPage = (page: FinancialPage) => {
    if (adminCollectionFocus && page !== 'collection') {
      clearPosCollectionReturn(profile.id);
      setAdminCollectionFocus(null);
      setFocusedCollectionServiceDate(null);
    }
    setFinancialPage(page);
  };

  return (
    <AdminLayout
      activeView={currentView}
      allowedViews={allowedViews}
      financialPage={financialPage}
      onNavigate={navigate}
      onFinancialPageChange={changeFinancialPage}
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
      {profile.role === 'admin' && visitedViews.has('executive_reports') && (
        <KeepAlive active={currentView === 'executive_reports'}>
          <ExecutiveReportsPage isActive={currentView === 'executive_reports'} />
        </KeepAlive>
      )}
      {visitedViews.has('events') && (
        <KeepAlive active={currentView === 'events'}>
          <EventManagementPage
            initialSelectedId={selectedEventJobId}
            isActive={currentView === 'events'}
            onSelectedIdChange={setSelectedEventJobId}
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
            canCollectShopPayments={canCollectPayments}
            casualCustomerEnabled
            isActive={currentView === 'delivery'}
            onDraftStateChange={setDeliveryDraftState}
            onOpenCollection={(request) => {
              setCollectionCloseResult(null);
              setAdminCollectionFocus(request);
              setFocusedCollectionServiceDate(request.source === 'pos-shortcut' ? currentBangkokDate : billingServiceDate);
              setVisitedViews((views) => new Set([...views, 'financial_operations']));
              setFinancialPage('collection');
              setActiveView('financial_operations');
            }}
            requestScope={profile.id}
            collectionReturnOrigin="admin-delivery"
            collectionCloseResult={collectionCloseResult}
            serviceDate={profile.role === 'admin' ? billingServiceDate : undefined}
            stockSourceLabel="สต๊อกรวมประจำวัน"
          />
        </KeepAlive>
      )}
      {visitedViews.has('financial_operations') && (
        <KeepAlive active={currentView === 'financial_operations'}>
          <FinancialOperations
            canCollectShopPayments={canCollectPayments}
            currentUserId={profile.id}
            focusRequest={adminCollectionFocus}
            isActive={currentView === 'financial_operations'}
            managerPage={financialPage}
            onFocusedCollectionClose={(result) => {
              setCollectionCloseResult(result);
              setAdminCollectionFocus(null);
              setFocusedCollectionServiceDate(null);
              setActiveView('delivery');
            }}
            onManagerPageChange={changeFinancialPage}
            serviceDate={adminCollectionFocus ? focusedCollectionServiceDate ?? undefined : profile.role === 'admin' ? billingServiceDate : undefined}
            userRole={profile.role}
          />
        </KeepAlive>
      )}
    </AdminLayout>
  );

}

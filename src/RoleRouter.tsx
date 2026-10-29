import { OfflineConflictReview } from './offline/runtime/OfflineConflictReview';
import { createEmployeeRuntime, preparedProfile, hasUnsentWork } from './offline/runtime/client';
import { createOfflineGateway } from './offline/runtime/gateway';
import { OfflineStatus } from './offline/runtime/OfflineStatus';
import { OnlineWriteRecovery } from './offline/runtime/OnlineWriteRecovery';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { KeepAlive } from './KeepAlive';
import { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import type { AdminView, FinancialPage } from './AdminLayout';
import { EmployeeLayout } from './EmployeeLayout';
import { EmployeeDeliveryWorkspace, createSupabaseGateway } from './EmployeeDeliveryWorkspace';
import { FinancialOperations } from './FinancialOperations';
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
import { LanguageSwitcher, localizeErrorMessage, useLanguage } from './i18n';

// The employee build removes this import and all admin screens from its output.
const AdminRoleWorkspace = import.meta.env.VITE_EMPLOYEE_ONLY === 'true'
  ? null
  : lazy(() => import('./AdminRoleWorkspace'));

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
  const { language, t } = useLanguage();
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
  const liveEmployeeGateway = useMemo(() => typeof indexedDB !== 'undefined' ? createSupabaseGateway() : undefined, [session.user.id]);
  const offlineRuntime = useMemo(() => profile?.role === 'courier' && profile.is_active && liveEmployeeGateway
    ? createEmployeeRuntime(session.user.id, currentBangkokDate, liveEmployeeGateway) : null,
  [profile?.role, profile?.is_active, session.user.id, currentBangkokDate, liveEmployeeGateway]);
  const employeeGateway = useMemo(() => offlineRuntime && liveEmployeeGateway ? createOfflineGateway(liveEmployeeGateway, offlineRuntime) : liveEmployeeGateway, [liveEmployeeGateway, offlineRuntime]);
  useEffect(() => offlineRuntime?.start(), [offlineRuntime]);
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
          .select('id, code, display_name, nickname, phone, role, is_active, can_collect_shop_payments')
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

    if (navigator.onLine) void loadProfile(true);
    void (async () => {
      const offlineProfile = await preparedProfile(session.user.id);
      if (!cancelled && !hasValidatedProfile && offlineProfile) {
        setProfile(offlineProfile); setProfilePreview(offlineProfile); setProfileLoading(false);
        hasValidatedProfile = true;
      }
      if (!navigator.onLine && !offlineProfile && !cancelled) { setProfileError('ยังไม่ได้เตรียมข้อมูลออฟไลน์ กรุณาเชื่อมต่ออินเทอร์เน็ต'); setProfileLoading(false); }
    })();
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
      setFinancialPage(saved?.financialPage === 'transactions' || saved?.financialPage === 'credit' || saved?.financialPage === 'credit_signoff' ? saved.financialPage : 'collection');
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
    // Courier workspaces own foreground refresh and its cooldown. Global resume
    // broadcasts bypassed that cooldown and cancelled fresh POS reads.
    return initGlobalRealtimeSync({ enableFocusCatchup: profile?.role !== 'courier' && Boolean(profile) });
  }, [profile?.role]);

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
    return !deliveryDraftState.dirty || window.confirm(t('unsavedConfirm'));
  };

  const signOut = async () => {
    if (typeof indexedDB !== 'undefined' && await hasUnsentWork(session.user.id)) {
      window.alert('มีรายการที่ยังไม่ได้ซิงก์ กรุณาซิงก์หรือให้แอดมินตรวจสอบก่อนออกจากระบบ');
      return;
    }
    if (!confirmLeavingDelivery()) return;
    if (profile) {
      clearPosCollectionReturn(profile.id);
      clearNavigation(profile.id);
      clearRecoveryForOwner(profile.id);
      clearCachedUserProfile(profile.id);
    }
    await supabase?.auth.signOut({ scope: 'local' });
  };

  if (profileLoading || (profile && navigationReadyOwner !== profile.id)) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">{t('loadingPermissions')}</p>
          <h1>{t('checkingUser')}</h1>
          {profilePreview ? <p className="muted">{profilePreview.display_name}</p> : null}
        </section>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <LanguageSwitcher className="language-switcher--auth" />
          <p className="eyebrow">{t('userLoadFailed')}</p>
          <h1>{language === 'my' ? localizeErrorMessage(profileError) : profileError}</h1>
          <button className="ghost-button" onClick={signOut} type="button">
            {t('signOut')}
          </button>
        </section>
      </div>
    );
  }

  if (!profile?.is_active) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <LanguageSwitcher className="language-switcher--auth" />
          <p className="eyebrow">{t('accountInactive')}</p>
          <h1>{t('accountNotEnabled')}</h1>
          <p className="muted">
            {t('accountAuthCreated')}
          </p>
          <button className="ghost-button" onClick={signOut} type="button">
            {t('signOut')}
          </button>
        </section>
      </div>
    );
  }

  const canCollectPayments = canUserProfileCollectPayments(profile);

  if (profile.role === 'courier') {
    return (
      <EmployeeLayout onSignOut={signOut} profileLabel={profile.display_name} signOutDisabled={deliveryDraftState.submitting}>
        <nav aria-label={t('employeeTasks')} className="employee-task-tabs">
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
            <span>{t('stockReceiveReturn')}</span>
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
            <span>{t('collectMoney')}</span>
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
            <span>{t('eventShort')}</span>
          </button>
        </nav>
        {liveEmployeeGateway ? <OnlineWriteRecovery owner={session.user.id} live={liveEmployeeGateway} /> : null}
        {offlineRuntime ? <OfflineStatus runtime={offlineRuntime} /> : null}
        <KeepAlive active={courierView === 'withdrawal' || courierView === 'pos'}>
          <EmployeeDeliveryWorkspace
            gateway={employeeGateway}
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
            printerName={profile.nickname?.trim() || profile.display_name}
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
              offlineRuntime={offlineRuntime ?? undefined}
              canCollectShopPayments={canCollectPayments}
              currentUserId={profile.id}
              printerName={profile.nickname?.trim() || profile.display_name}
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

  if (!AdminRoleWorkspace) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <h1>แอปสำหรับพนักงานส่งน้ำแข็ง</h1>
          <p>กรุณาเข้าสู่ระบบด้วยบัญชีพนักงาน ส่วนแอดมินและหัวหน้าให้ใช้งานผ่านเว็บ</p>
          <button className="ghost-button" onClick={signOut} type="button">{t('signOut')}</button>
        </section>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="app-shell" role="status">{t('loadingPermissions')}</div>}>
      {liveEmployeeGateway ? <OnlineWriteRecovery owner={session.user.id} live={liveEmployeeGateway} /> : null}
      {profile.role === 'admin' ? <OfflineConflictReview /> : null}
      <AdminRoleWorkspace
        profile={profile}
        activeView={activeView}
        setActiveView={setActiveView}
        financialPage={financialPage}
        setFinancialPage={setFinancialPage}
        visitedViews={visitedViews}
        setVisitedViews={setVisitedViews}
        adminCollectionFocus={adminCollectionFocus}
        setAdminCollectionFocus={setAdminCollectionFocus}
        focusedCollectionServiceDate={focusedCollectionServiceDate}
        setFocusedCollectionServiceDate={setFocusedCollectionServiceDate}
        billingServiceDate={billingServiceDate}
        setBillingServiceDate={setBillingServiceDate}
        currentBangkokDate={currentBangkokDate}
        selectedEventJobId={selectedEventJobId}
        setSelectedEventJobId={setSelectedEventJobId}
        deliveryDraftState={deliveryDraftState}
        setDeliveryDraftState={setDeliveryDraftState}
        collectionCloseResult={collectionCloseResult}
        setCollectionCloseResult={setCollectionCloseResult}
        canCollectPayments={canCollectPayments}
        confirmLeavingDelivery={confirmLeavingDelivery}
        signOut={signOut}
      />
    </Suspense>
  );
}

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { AdminLayout, type AdminView, type FinancialPage } from './AdminLayout';
import { ManagerDashboard } from './ManagerDashboard';
import { ExecutiveReportsPage } from './features/reports/ExecutiveReportsPage';
import { FactoryOrderPage } from './FactoryOrderPage';
import { AdminReferenceSettings } from './AdminReferenceSettings';
import { OfflineConflictReview } from './offline/runtime/OfflineConflictReview';
import { LocationManagementSettings } from './LocationManagementSettings';
import { ShopSettings } from './ShopSettings';
import { RoundWorkspace } from './RoundWorkspace';
import { ManagerStockAudit } from './ManagerStockAudit';
import { EventManagementPage } from './EventManagementPage';
import { KeepAlive } from './KeepAlive';
import { EmployeeDeliveryWorkspace } from './EmployeeDeliveryWorkspace';
import { FinancialOperations } from './FinancialOperations';
import type { CollectionCloseResult, CollectionFocusRequest, UserProfile } from './types/app';
import { toBangkokDateString } from './lib/serviceDate';
import { clearPosCollectionReturn } from './lib/posCollectionReturn';

type Props = {
  profile: UserProfile;
  activeView: AdminView;
  setActiveView: Dispatch<SetStateAction<AdminView>>;
  financialPage: FinancialPage;
  setFinancialPage: Dispatch<SetStateAction<FinancialPage>>;
  visitedViews: Set<AdminView>;
  setVisitedViews: Dispatch<SetStateAction<Set<AdminView>>>;
  adminCollectionFocus: CollectionFocusRequest | null;
  setAdminCollectionFocus: Dispatch<SetStateAction<CollectionFocusRequest | null>>;
  focusedCollectionServiceDate: string | null;
  setFocusedCollectionServiceDate: Dispatch<SetStateAction<string | null>>;
  billingServiceDate: string;
  setBillingServiceDate: Dispatch<SetStateAction<string>>;
  currentBangkokDate: string;
  selectedEventJobId: string | null;
  setSelectedEventJobId: Dispatch<SetStateAction<string | null>>;
  deliveryDraftState: { dirty: boolean; submitting: boolean };
  setDeliveryDraftState: Dispatch<SetStateAction<{ dirty: boolean; submitting: boolean }>>;
  collectionCloseResult: CollectionCloseResult | null;
  setCollectionCloseResult: Dispatch<SetStateAction<CollectionCloseResult | null>>;
  canCollectPayments: boolean;
  confirmLeavingDelivery: () => boolean;
  signOut: () => Promise<void>;
};

export default function AdminRoleWorkspace({
  profile,
  activeView,
  setActiveView,
  financialPage,
  setFinancialPage,
  visitedViews,
  setVisitedViews,
  adminCollectionFocus,
  setAdminCollectionFocus,
  focusedCollectionServiceDate,
  setFocusedCollectionServiceDate,
  billingServiceDate,
  setBillingServiceDate,
  currentBangkokDate,
  selectedEventJobId,
  setSelectedEventJobId,
  deliveryDraftState,
  setDeliveryDraftState,
  collectionCloseResult,
  setCollectionCloseResult,
  canCollectPayments,
  confirmLeavingDelivery,
  signOut,
}: Props) {
  const canManageRounds = profile.role === 'admin' || profile.role === 'round_lead';
  const currentView = canManageRounds
    ? (activeView === 'executive_reports' && profile.role !== 'admin' ? 'manager_overview' : activeView)
    : 'delivery';

  // Preserve visited views without updating the parent during this render.
  useEffect(() => {
    if (!visitedViews.has(currentView)) {
      setVisitedViews((prev) => new Set([...prev, currentView]));
    }
  }, [currentView, setVisitedViews, visitedViews]);

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
          {profile.role === 'admin' ? <OfflineConflictReview /> : null}
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
            canPrintCreditWithVat
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
            printerName={profile.nickname?.trim() || profile.display_name}
          />
        </KeepAlive>
      )}
      {visitedViews.has('financial_operations') && (
        <KeepAlive active={currentView === 'financial_operations'}>
          <FinancialOperations
            canCollectShopPayments={canCollectPayments}
            currentUserId={profile.id}
            printerName={profile.nickname?.trim() || profile.display_name}
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

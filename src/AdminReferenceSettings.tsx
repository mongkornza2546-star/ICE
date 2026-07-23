import { useEffect, useState } from 'react';
import { Cube, UsersThree } from '@phosphor-icons/react';
import type { UserProfile } from './types/app';
import type {
  EmployeeWorkSiteAssignment,
  IceTypeSetting,
  WorkSiteOption,
} from './features/admin-reference-settings/types';
import { loadAdminSettings } from './features/admin-reference-settings/adminReferenceSettingsService';
import { UserEditor } from './features/admin-reference-settings/components/UserEditor';
import { IceTypeEditor } from './features/admin-reference-settings/components/IceTypeEditor';

export function AdminReferenceSettings() {
  return <AdminReferenceSettingsContent />;
}

export type ReferenceTab = 'users' | 'ice_types';

function AdminReferenceSettingsContent() {
  const [activeTab, setActiveTab] = useState<ReferenceTab>('users');
  const [createIceTypeRequested, setCreateIceTypeRequested] = useState(false);

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [workSites, setWorkSites] = useState<WorkSiteOption[]>([]);
  const [workSiteAssignments, setWorkSiteAssignments] = useState<EmployeeWorkSiteAssignment[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeSetting[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setAuthorized(false);
      setPageError(null);

      try {
        const data = await loadAdminSettings(() => cancelled);
        if (cancelled || !data) return;

        setCurrentUserId(data.currentUserId);
        setUsers(data.users);
        setWorkSites(data.workSites);
        setWorkSiteAssignments(data.workSiteAssignments);
        setIceTypes(data.iceTypes);
        setAuthorized(true);
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleUserSaved(savedUser: UserProfile, workSiteIds: string[]) {
    setUsers((current) => current.map((user) => user.id === savedUser.id ? savedUser : user));
    setWorkSiteAssignments((current) => [
      ...current.filter((assignment) => assignment.user_id !== savedUser.id),
      ...workSiteIds.map((stockLocationId) => ({
        user_id: savedUser.id,
        stock_location_id: stockLocationId,
      })),
    ]);
  }

  function handleIceTypeSaved(savedIceType: IceTypeSetting) {
    setIceTypes((current) => {
      const exists = current.some((iceType) => iceType.id === savedIceType.id);
      const next = exists
        ? current.map((iceType) => iceType.id === savedIceType.id ? savedIceType : iceType)
        : [...current, savedIceType];
      return next.sort((left, right) => left.code.localeCompare(right.code));
    });
  }

  if (loading) {
    return <p className="empty-text">กำลังตรวจสอบสิทธิ์และโหลดข้อมูลตั้งค่า...</p>;
  }

  if (!authorized) {
    return (
      <section className="panel center-panel error-panel">
        <p className="eyebrow">ไม่สามารถเปิดหน้าตั้งค่า</p>
        <h2>ตรวจสอบสิทธิ์แอดมินไม่สำเร็จ</h2>
        <p className="error-text" role="alert">{pageError ?? 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'}</p>
        <button className="ghost-button" onClick={() => window.location.reload()} type="button">ตรวจสอบอีกครั้ง</button>
      </section>
    );
  }

  return (
    <div className="reference-settings-page">
      {/* Top Page Header */}
      <header className="ref-page-header">
        <div className="ref-page-header__titles">
          <h1>ผู้ใช้และชนิดน้ำแข็ง</h1>
          <p>
            {activeTab === 'users'
              ? 'จัดการผู้ใช้ระบบและชนิดน้ำแข็งที่ใช้งานในการจัดส่ง'
              : 'จัดการผู้ใช้งานระบบและชนิดน้ำแข็งที่ให้บริการ'}
          </p>
        </div>
        {activeTab === 'ice_types' ? (
          <div className="ref-page-header__actions">
            <button
              className="primary-button ref-create-btn"
              onClick={() => setCreateIceTypeRequested(true)}
              type="button"
            >
              <span>+</span>
              <span>เพิ่มชนิดน้ำแข็ง</span>
            </button>
          </div>
        ) : null}
      </header>

      {/* Tabs Navigation */}
      <nav className="ref-nav-tabs" aria-label="หมวดหมู่การตั้งค่า">
        <button
          className={`ref-nav-tab ${activeTab === 'users' ? 'ref-nav-tab--active' : ''}`}
          onClick={() => setActiveTab('users')}
          type="button"
        >
          <UsersThree size={20} weight={activeTab === 'users' ? 'bold' : 'regular'} />
          <span>ผู้ใช้ระบบ</span>
        </button>
        <button
          className={`ref-nav-tab ${activeTab === 'ice_types' ? 'ref-nav-tab--active' : ''}`}
          onClick={() => setActiveTab('ice_types')}
          type="button"
        >
          <Cube size={20} weight={activeTab === 'ice_types' ? 'bold' : 'regular'} />
          <span>ชนิดน้ำแข็ง</span>
        </button>
      </nav>

      {/* Tab Content Panels */}
      {activeTab === 'users' ? (
        <UserEditor
          currentUserId={currentUserId}
          onUserSaved={handleUserSaved}
          users={users}
          workSiteAssignments={workSiteAssignments}
          workSites={workSites}
        />
      ) : (
        <IceTypeEditor
          createRequested={createIceTypeRequested}
          iceTypes={iceTypes}
          onCreateHandled={() => setCreateIceTypeRequested(false)}
          onIceTypeSaved={handleIceTypeSaved}
        />
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Cube, UsersThree } from '@phosphor-icons/react';
import type { UserProfile } from './types/app';
import type { IceTypeSetting } from './features/admin-reference-settings/types';
import type { DeliveryRoundNameSetting } from './features/admin-reference-settings/types';
import { loadAdminSettings } from './features/admin-reference-settings/adminReferenceSettingsService';
import { UserEditor } from './features/admin-reference-settings/components/UserEditor';
import { IceTypeEditor } from './features/admin-reference-settings/components/IceTypeEditor';
import { DeliveryRoundNameEditor } from './features/admin-reference-settings/components/DeliveryRoundNameEditor';

export function AdminReferenceSettings() {
  return <AdminReferenceSettingsContent />;
}

function AdminReferenceSettingsContent() {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeSetting[]>([]);
  const [roundNames, setRoundNames] = useState<DeliveryRoundNameSetting[]>([]);
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
        setIceTypes(data.iceTypes);
        setRoundNames(data.roundNames);
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

  function handleUserSaved(savedUser: UserProfile) {
    setUsers((current) => current.map((user) => user.id === savedUser.id ? savedUser : user));
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

  function handleRoundNameSaved(savedRoundName: DeliveryRoundNameSetting) {
    setRoundNames((current) => {
      const exists = current.some((option) => option.id === savedRoundName.id);
      const next = exists ? current.map((option) => option.id === savedRoundName.id ? savedRoundName : option) : [...current, savedRoundName];
      return next.sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));
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
      <section className="reference-stats-grid" aria-label="สรุปข้อมูลระบบ">
        <article className="reference-stat-card">
          <div className="reference-stat-card__icon"><UsersThree size={34} /></div>
          <div className="reference-stat-card__content">
            <p>ผู้ใช้ทั้งหมด</p>
            <strong>{users.length}</strong>
            <span>บัญชี</span>
          </div>
        </article>
        <article className="reference-stat-card">
          <div className="reference-stat-card__icon"><Cube size={34} /></div>
          <div className="reference-stat-card__content">
            <p>ชนิดน้ำแข็ง</p>
            <strong>{iceTypes.length}</strong>
            <span>รายการ</span>
          </div>
        </article>
      </section>

      <UserEditor
        currentUserId={currentUserId}
        onUserSaved={handleUserSaved}
        users={users}
      />

      <IceTypeEditor
        iceTypes={iceTypes}
        onIceTypeSaved={handleIceTypeSaved}
      />
      <DeliveryRoundNameEditor options={roundNames} onSaved={handleRoundNameSaved} />
    </div>
  );
}

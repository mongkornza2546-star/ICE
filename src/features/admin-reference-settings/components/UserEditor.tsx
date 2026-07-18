import { type FormEvent, useMemo, useState } from 'react';
import {
  CheckCircle,
  Circle,
  FunnelSimple,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import type { UserProfile, AppRole } from '../../../types/app';
import { ROLE_OPTIONS, type UserDraft } from '../types';
import { updateUser, getErrorMessage } from '../adminReferenceSettingsService';
import {
  filterLabel,
  matchesActiveFilter,
  matchesQuery,
  nextFilter,
  type ActiveFilter,
} from '../referenceEditorFilters';

interface UserEditorProps {
  users: UserProfile[];
  currentUserId: string;
  onUserSaved: (savedUser: UserProfile) => void;
}

function toUserDraft(user: UserProfile): UserDraft {
  return {
    id: user.id,
    code: user.code,
    displayName: user.display_name,
    phone: user.phone ?? '',
    role: user.role,
    isActive: user.is_active,
  };
}

function roleLabel(role: AppRole) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

export function UserEditor({ users, currentUserId, onUserSaved }: UserEditorProps) {
  const [userDraft, setUserDraft] = useState<UserDraft | null>(() => users.length > 0 ? toUserDraft(users[0]) : null);
  const [userQuery, setUserQuery] = useState('');
  const [userFilter, setUserFilter] = useState<ActiveFilter>('all');
  
  const [savingUser, setSavingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userSuccess, setUserSuccess] = useState<string | null>(null);

  const filteredUsers = useMemo(
    () => users
      .filter((user) => matchesQuery(userQuery, [user.code, user.display_name, user.phone, roleLabel(user.role)]))
      .filter((user) => matchesActiveFilter(user.is_active, userFilter)),
    [userFilter, userQuery, users],
  );

  function chooseUser(user: UserProfile) {
    setUserDraft(toUserDraft(user));
    setUserError(null);
    setUserSuccess(null);
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userDraft) return;

    const displayName = userDraft.displayName.trim();
    if (!displayName) {
      setUserError('กรุณาระบุชื่อผู้ใช้');
      return;
    }

    const original = users.find((user) => user.id === userDraft.id);
    if (!original) {
      setUserError('ไม่พบโปรไฟล์ผู้ใช้ที่เลือก กรุณาโหลดหน้าใหม่');
      return;
    }

    const isCurrentUser = original.id === currentUserId;
    setSavingUser(true);
    setUserError(null);
    setUserSuccess(null);

    try {
      const savedUser = await updateUser(original.id, {
        display_name: displayName,
        phone: userDraft.phone.trim() || null,
        role: isCurrentUser ? original.role : userDraft.role,
        is_active: isCurrentUser ? original.is_active : userDraft.isActive,
      });

      onUserSaved(savedUser);
      setUserDraft(toUserDraft(savedUser));
      setUserSuccess('บันทึกข้อมูลผู้ใช้แล้ว');
    } catch (error) {
      setUserError(getErrorMessage(error));
    } finally {
      setSavingUser(false);
    }
  }

  const editingCurrentUser = userDraft?.id === currentUserId;
  const userFilterLabel = filterLabel(userFilter);

  return (
    <section className="reference-editor-panel">
      <div className="reference-editor-panel__header">
        <span>1</span>
        <h2>จัดการผู้ใช้</h2>
      </div>

      <div className="reference-editor-panel__body">
        <div className="reference-editor-panel__column reference-editor-panel__column--list">
          <div className="reference-toolbar">
            <label className="reference-search-field">
              <MagnifyingGlass aria-hidden="true" size={20} />
              <input
                onChange={(event) => setUserQuery(event.target.value)}
                placeholder="ค้นหาผู้ใช้"
                value={userQuery}
              />
            </label>
            <button
              aria-label={`กรองผู้ใช้: ${userFilterLabel}`}
              className={`reference-filter-button ${userFilter !== 'all' ? 'reference-filter-button--active' : ''}`}
              onClick={() => setUserFilter(nextFilter(userFilter))}
              title={`กรองผู้ใช้: ${userFilterLabel}`}
              type="button"
            >
              <FunnelSimple size={20} />
            </button>
          </div>

          <div className="reference-list">
            {filteredUsers.map((user) => {
              const selected = userDraft?.id === user.id;
              return (
                <button
                  aria-current={selected ? 'true' : undefined}
                  className={`reference-list-item ${selected ? 'reference-list-item--selected' : ''}`}
                  key={user.id}
                  onClick={() => chooseUser(user)}
                  type="button"
                >
                  <span className="reference-list-item__radio" aria-hidden="true">
                    {selected ? <CheckCircle size={20} weight="fill" /> : <Circle size={20} />}
                  </span>
                  <span className="reference-list-item__body">
                    <strong>{user.code}</strong>
                    <small>{user.display_name}</small>
                  </span>
                  <span className="reference-list-item__tags">
                    <span className="reference-pill reference-pill--blue">{roleLabel(user.role)}</span>
                    <span className={`reference-pill ${user.is_active ? 'reference-pill--green' : 'reference-pill--gray'}`}>
                      {user.is_active ? 'ใช้งาน' : 'พักใช้งาน'}
                    </span>
                  </span>
                </button>
              );
            })}
            {filteredUsers.length === 0 ? <p className="empty-text">ไม่พบผู้ใช้ตามคำค้นหรือเงื่อนไขที่เลือก</p> : null}
          </div>

          <p className="reference-list__meta">
            แสดง {filteredUsers.length === 0 ? 0 : 1}-{filteredUsers.length} จาก {users.length} บัญชี
          </p>
        </div>

        <div className="reference-editor-panel__divider" aria-hidden="true" />

        <div className="reference-editor-panel__column reference-editor-panel__column--form">
          <div className="reference-form-heading">
            <h3>แก้ไขผู้ใช้</h3>
          </div>
          {userDraft ? (
            <form className="reference-form" onSubmit={saveUser}>
              <div className="field-grid">
                <label>รหัสผู้ใช้<input readOnly value={userDraft.code} /></label>
                <label>ชื่อแสดง<input required value={userDraft.displayName} onChange={(event) => setUserDraft({ ...userDraft, displayName: event.target.value })} /></label>
                <label>เบอร์โทร<input placeholder="ระบุเบอร์โทร (ถ้ามี)" type="tel" value={userDraft.phone} onChange={(event) => setUserDraft({ ...userDraft, phone: event.target.value })} /></label>
                <label>
                  บทบาท
                  <select disabled={editingCurrentUser} value={userDraft.role} onChange={(event) => setUserDraft({ ...userDraft, role: event.target.value as AppRole })}>
                    {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                  </select>
                </label>
              </div>
              <label className="inline-check reference-checkbox">
                <input checked={userDraft.isActive} disabled={editingCurrentUser} onChange={(event) => setUserDraft({ ...userDraft, isActive: event.target.checked })} type="checkbox" />
                เปิดใช้งานบัญชีนี้
              </label>
              {editingCurrentUser ? <p className="muted">บัญชีที่กำลังใช้งานเปลี่ยนบทบาทหรือพักใช้งานตัวเองจากหน้านี้ไม่ได้</p> : null}
              {userError ? <p className="error-text" role="alert">{userError}</p> : null}
              {userSuccess ? <p aria-live="polite" className="success-text">{userSuccess}</p> : null}
              <div className="reference-form__actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    const original = users.find((user) => user.id === userDraft.id);
                    if (original) chooseUser(original);
                  }}
                  type="button"
                >
                  ยกเลิก
                </button>
                <button className="primary-button" disabled={savingUser} type="submit">
                  {savingUser ? 'กำลังบันทึก...' : 'บันทึกผู้ใช้'}
                </button>
              </div>
            </form>
          ) : <p className="empty-text">เลือกผู้ใช้จากรายการเพื่อแก้ไข</p>}
        </div>
      </div>
    </section>
  );
}

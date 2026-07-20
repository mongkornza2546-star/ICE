import { type FormEvent, useMemo, useState } from 'react';
import {
  CheckCircle,
  Circle,
  FunnelSimple,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import type { UserProfile, AppRole } from '../../../types/app';
import {
  ROLE_OPTIONS,
  type EmployeeWorkSiteAssignment,
  type UserDraft,
  type WorkSiteOption,
} from '../types';
import { saveUserWithWorkSiteAssignments, getErrorMessage } from '../adminReferenceSettingsService';
import {
  filterLabel,
  matchesActiveFilter,
  matchesQuery,
  nextFilter,
  type ActiveFilter,
} from '../referenceEditorFilters';

interface UserEditorProps {
  users: UserProfile[];
  workSites: WorkSiteOption[];
  workSiteAssignments: EmployeeWorkSiteAssignment[];
  currentUserId: string;
  onUserSaved: (savedUser: UserProfile, workSiteIds: string[]) => void;
}

function toUserDraft(
  user: UserProfile,
  workSiteAssignments: EmployeeWorkSiteAssignment[],
  workSites: WorkSiteOption[],
): UserDraft {
  const activeWorkSiteIds = new Set(workSites.map((workSite) => workSite.id));
  return {
    id: user.id,
    code: user.code,
    displayName: user.display_name,
    phone: user.phone ?? '',
    role: user.role,
    isActive: user.is_active,
    workSiteIds: workSiteAssignments
      .filter((assignment) => assignment.user_id === user.id)
      .map((assignment) => assignment.stock_location_id)
      .filter((workSiteId) => activeWorkSiteIds.has(workSiteId)),
  };
}

function roleLabel(role: AppRole) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

export function UserEditor({
  users,
  workSites,
  workSiteAssignments,
  currentUserId,
  onUserSaved,
}: UserEditorProps) {
  const [userDraft, setUserDraft] = useState<UserDraft | null>(() => (
    users.length > 0 ? toUserDraft(users[0], workSiteAssignments, workSites) : null
  ));
  const [userQuery, setUserQuery] = useState('');
  const [userFilter, setUserFilter] = useState<ActiveFilter>('all');
  
  const [savingUser, setSavingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userSuccess, setUserSuccess] = useState<string | null>(null);

  const assignedWorkSitesByUser = useMemo(() => {
    const workSiteById = new Map(workSites.map((workSite) => [workSite.id, workSite]));
    const result = new Map<string, WorkSiteOption[]>();
    for (const assignment of workSiteAssignments) {
      const workSite = workSiteById.get(assignment.stock_location_id);
      if (!workSite) continue;
      result.set(assignment.user_id, [...(result.get(assignment.user_id) ?? []), workSite]);
    }
    return result;
  }, [workSiteAssignments, workSites]);

  const filteredUsers = useMemo(
    () => users
      .filter((user) => matchesQuery(userQuery, [
        user.code,
        user.display_name,
        user.phone,
        roleLabel(user.role),
        ...(assignedWorkSitesByUser.get(user.id) ?? []).flatMap((workSite) => [workSite.code, workSite.name]),
      ]))
      .filter((user) => matchesActiveFilter(user.is_active, userFilter)),
    [assignedWorkSitesByUser, userFilter, userQuery, users],
  );

  function chooseUser(user: UserProfile) {
    setUserDraft(toUserDraft(user, workSiteAssignments, workSites));
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
      const saved = await saveUserWithWorkSiteAssignments(original.id, {
        display_name: displayName,
        phone: userDraft.phone.trim() || null,
        role: isCurrentUser ? original.role : userDraft.role,
        is_active: isCurrentUser ? original.is_active : userDraft.isActive,
      }, userDraft.role === 'courier' && userDraft.isActive ? userDraft.workSiteIds : []);

      onUserSaved(saved.user, saved.work_site_ids);
      setUserDraft({
        ...toUserDraft(saved.user, [], workSites),
        workSiteIds: saved.work_site_ids,
      });
      setUserSuccess('บันทึกข้อมูลผู้ใช้และจุดประจำแล้ว');
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
              const assignedWorkSites = assignedWorkSitesByUser.get(user.id) ?? [];
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
                    <small className="reference-list-item__assignment">
                      {assignedWorkSites.length > 0
                        ? `ประจำ ${assignedWorkSites.map((workSite) => workSite.name).join(', ')}`
                        : 'ยังไม่กำหนดจุดประจำ'}
                    </small>
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
                  <select
                    disabled={editingCurrentUser}
                    value={userDraft.role}
                    onChange={(event) => {
                      const role = event.target.value as AppRole;
                      setUserDraft({
                        ...userDraft,
                        role,
                        workSiteIds: role === 'courier' ? userDraft.workSiteIds : [],
                      });
                    }}
                  >
                    {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                  </select>
                </label>
              </div>
              <fieldset className="reference-assignment-fieldset" disabled={userDraft.role !== 'courier' || !userDraft.isActive}>
                <legend>จุดปฏิบัติงานประจำ</legend>
                <p className="muted">เลือกได้มากกว่าหนึ่งจุด ข้อมูลนี้ใช้ระบุว่าพนักงานแต่ละคนดูแลจุดใดบ้าง</p>
                <div className="reference-assignment-list">
                  {workSites.map((workSite) => {
                    const checked = userDraft.workSiteIds.includes(workSite.id);
                    return (
                      <label className={`reference-assignment-option ${checked ? 'reference-assignment-option--selected' : ''}`} key={workSite.id}>
                        <input
                          checked={checked}
                          onChange={(event) => setUserDraft({
                            ...userDraft,
                            workSiteIds: event.target.checked
                              ? [...userDraft.workSiteIds, workSite.id]
                              : userDraft.workSiteIds.filter((id) => id !== workSite.id),
                          })}
                          type="checkbox"
                        />
                        <span><strong>{workSite.name}</strong><small>{workSite.code}</small></span>
                      </label>
                    );
                  })}
                  {workSites.length === 0 ? <p className="empty-text">ยังไม่มีจุดปฏิบัติงานที่เปิดใช้งาน</p> : null}
                </div>
                {userDraft.role !== 'courier' ? <p className="muted">การกำหนดจุดประจำใช้กับบทบาทพนักงานส่งเท่านั้น</p> : null}
              </fieldset>
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

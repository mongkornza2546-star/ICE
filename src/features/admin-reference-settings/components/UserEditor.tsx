import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  Circle,
  FunnelSimple,
  ImageSquare,
  MagnifyingGlass,
  UploadSimple,
} from '@phosphor-icons/react';
import type { UserProfile, AppRole } from '../../../types/app';
import {
  ROLE_OPTIONS,
  type EmployeeWorkSiteAssignment,
  type UserDraft,
  type WorkSiteOption,
  ALLOWED_USER_AVATAR_TYPES,
  MAX_USER_AVATAR_SIZE,
} from '../types';
import {
  getErrorMessage,
  getUserAvatarSignedUrl,
  removeUserAvatarFiles,
  saveUserWithWorkSiteAssignments,
  uploadUserAvatar,
} from '../adminReferenceSettingsService';
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
    nickname: user.nickname ?? '',
    avatarPath: user.avatar_path ?? null,
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

function UserAvatar({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUserAvatarSignedUrl(path).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    }).catch(() => {
      if (!cancelled) setUrl(null);
    });
    return () => { cancelled = true; };
  }, [path]);

  return url ? <img alt="" src={url} /> : <ImageSquare size={18} />;
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
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);

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

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreviewUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(avatarFile);
    setAvatarPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [avatarFile]);

  useEffect(() => {
    let cancelled = false;
    const avatarPath = userDraft?.avatarPath;
    if (avatarFile || !avatarPath) {
      setAvatarUrl(null);
      return undefined;
    }
    getUserAvatarSignedUrl(avatarPath).then((url) => {
      if (!cancelled) setAvatarUrl(url);
    }).catch(() => {
      if (!cancelled) setAvatarUrl(null);
    });
    return () => { cancelled = true; };
  }, [avatarFile, userDraft?.avatarPath]);

  function chooseUser(user: UserProfile) {
    setUserDraft(toUserDraft(user, workSiteAssignments, workSites));
    setAvatarFile(null);
    setUserError(null);
    setUserSuccess(null);
  }

  function chooseAvatarFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_USER_AVATAR_SIZE) {
      setUserError('รูปต้องมีขนาดไม่เกิน 5 MB');
      return;
    }
    if (file.type && !ALLOWED_USER_AVATAR_TYPES.has(file.type)) {
      setUserError('รองรับเฉพาะไฟล์ JPG, PNG หรือ WEBP');
      return;
    }
    setAvatarFile(file);
    setUserError(null);
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
    let uploadedAvatarPath: string | null = null;

    try {
      let avatarPath = userDraft.avatarPath;
      if (avatarFile) {
        avatarPath = await uploadUserAvatar(original.id, avatarFile);
        uploadedAvatarPath = avatarPath;
      }

      const saved = await saveUserWithWorkSiteAssignments(original.id, {
        display_name: displayName,
        nickname: userDraft.nickname.trim() || null,
        avatar_path: avatarPath,
        phone: userDraft.phone.trim() || null,
        role: isCurrentUser ? original.role : userDraft.role,
        is_active: isCurrentUser ? original.is_active : userDraft.isActive,
      }, userDraft.role === 'courier' && userDraft.isActive ? userDraft.workSiteIds : []);

      if (avatarFile && userDraft.avatarPath && userDraft.avatarPath !== avatarPath) {
        await removeUserAvatarFiles([userDraft.avatarPath]).catch(() => {});
      }
      onUserSaved(saved.user, saved.work_site_ids);
      setUserDraft({
        ...toUserDraft(saved.user, [], workSites),
        workSiteIds: saved.work_site_ids,
      });
      setAvatarFile(null);
      setUserSuccess('บันทึกข้อมูลผู้ใช้และจุดประจำแล้ว');
    } catch (error) {
      if (uploadedAvatarPath) await removeUserAvatarFiles([uploadedAvatarPath]).catch(() => {});
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
                  <span className="user-avatar user-avatar--list" aria-hidden="true">
                    {user.avatar_path ? <UserAvatar path={user.avatar_path} /> : <ImageSquare size={18} />}
                  </span>
                  <span className="reference-list-item__body">
                    <strong>{user.display_name}{user.nickname ? ` (${user.nickname})` : ''}</strong>
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
                <label>ชื่อแสดง<input required value={userDraft.displayName} onChange={(event) => setUserDraft({ ...userDraft, displayName: event.target.value })} /></label>
                <label>ชื่อเล่น<input placeholder="เช่น บอย" value={userDraft.nickname} onChange={(event) => setUserDraft({ ...userDraft, nickname: event.target.value })} /></label>
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
              <div className="reference-user-avatar-editor">
                <span className="user-avatar user-avatar--preview">
                  {avatarPreviewUrl ?? avatarUrl ? <img alt={`รูปของ ${userDraft.displayName}`} src={avatarPreviewUrl ?? avatarUrl ?? ''} /> : <ImageSquare aria-hidden="true" size={32} />}
                </span>
                <div>
                  <strong>รูปพนักงาน</strong>
                  <small>รองรับ JPG, PNG, WEBP ขนาดไม่เกิน 5 MB</small>
                  <label className="secondary-button reference-upload-button"><UploadSimple size={18} /><span>{userDraft.avatarPath ? 'เปลี่ยนรูป' : 'เลือกรูป'}</span><input accept="image/jpeg,image/png,image/webp" aria-label="รูปพนักงาน" onChange={chooseAvatarFile} type="file" /></label>
                </div>
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

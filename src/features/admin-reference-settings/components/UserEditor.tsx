import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Camera,
  Check,
  FunnelSimple,
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

function getAvatarInitial(user: UserProfile) {
  const name = user.nickname || user.display_name || user.code || 'U';
  return name.trim().charAt(0).toUpperCase();
}

function getAvatarBgColor(user: UserProfile) {
  if (user.role === 'admin') return '#8B5CF6'; // Purple
  const charCode = (user.display_name || user.code || 'A').charCodeAt(0);
  const colors = ['#3B82F6', '#EAB308', '#0D9488', '#EC4899', '#6366F1', '#14B8A6'];
  return colors[charCode % colors.length];
}

function UserAvatar({ path, fallbackInitial, bgColor }: { path?: string | null; fallbackInitial: string; bgColor: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setUrl(null);
      return undefined;
    }
    let cancelled = false;
    getUserAvatarSignedUrl(path).then((nextUrl) => {
      if (!cancelled) setUrl(nextUrl);
    }).catch(() => {
      if (!cancelled) setUrl(null);
    });
    return () => { cancelled = true; };
  }, [path]);

  if (url) {
    return <img alt="" src={url} className="ref-avatar-img" />;
  }

  return (
    <div className="ref-avatar-initial" style={{ backgroundColor: bgColor }}>
      {fallbackInitial}
    </div>
  );
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
        user.nickname,
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
  const selectedUserObj = users.find((u) => u.id === userDraft?.id);

  return (
    <div className="ref-split-layout">
      {/* Left Column: User List */}
      <div className="ref-left-panel">
        <div className="ref-toolbar">
          <div className="ref-search-input">
            <MagnifyingGlass aria-hidden="true" size={18} />
            <input
              onChange={(event) => setUserQuery(event.target.value)}
              placeholder="ค้นหาผู้ใช้"
              value={userQuery}
            />
          </div>
          <button
            aria-label={`กรองผู้ใช้: ${userFilterLabel}`}
            className={`ref-filter-btn ${userFilter !== 'all' ? 'ref-filter-btn--active' : ''}`}
            onClick={() => setUserFilter(nextFilter(userFilter))}
            title={`กรองผู้ใช้: ${userFilterLabel}`}
            type="button"
          >
            <FunnelSimple size={18} />
          </button>
        </div>

        <div className="ref-list-subhead">
          <span>ทั้งหมด {filteredUsers.length} รายการ</span>
        </div>

        <div className="ref-item-list">
          {filteredUsers.map((user) => {
            const selected = userDraft?.id === user.id;
            const assignedWorkSites = assignedWorkSitesByUser.get(user.id) ?? [];
            const initial = getAvatarInitial(user);
            const bgColor = getAvatarBgColor(user);

            let sitesText = 'ยังไม่กำหนดจุดประจำ';
            if (user.role === 'admin') {
              sitesText = 'ทุกจุดปฏิบัติงาน';
            } else if (assignedWorkSites.length > 0) {
              sitesText = `ประจำ ${assignedWorkSites.map((ws) => ws.name).join(', ')}`;
            }

            return (
              <button
                aria-current={selected ? 'true' : undefined}
                className={`ref-user-card ${selected ? 'ref-user-card--selected' : ''}`}
                key={user.id}
                onClick={() => chooseUser(user)}
                type="button"
              >
                <div className="ref-user-card__checkbox">
                  <div className={`ref-checkbox-box ${selected ? 'ref-checkbox-box--checked' : ''}`}>
                    {selected ? <Check size={14} weight="bold" /> : null}
                  </div>
                </div>

                <div className="ref-user-card__avatar">
                  <UserAvatar path={user.avatar_path} fallbackInitial={initial} bgColor={bgColor} />
                </div>

                <div className="ref-user-card__body">
                  <div className="ref-user-card__header">
                    <span className="ref-user-card__email">{user.display_name}</span>
                  </div>
                  <div className="ref-user-card__role">{roleLabel(user.role)}</div>
                  <div className="ref-user-card__subtext">{sitesText}</div>
                </div>

                <div className="ref-user-card__badge-wrap">
                  <span className={`ref-pill ${user.is_active ? 'ref-pill--green' : 'ref-pill--amber'}`}>
                    {user.is_active ? 'ใช้งาน' : 'พักใช้งาน'}
                  </span>
                </div>
              </button>
            );
          })}
          {filteredUsers.length === 0 ? <p className="empty-text">ไม่พบผู้ใช้ตามคำค้นหรือเงื่อนไขที่เลือก</p> : null}
        </div>

        <div className="ref-pagination-footer">
          <button className="ref-page-btn" disabled type="button">&lt;</button>
          <span className="ref-page-num ref-page-num--active">1</span>
          <button className="ref-page-btn" disabled type="button">&gt;</button>
        </div>
      </div>

      {/* Right Column: User Detail Form */}
      <div className="ref-right-panel">
        <div className="ref-panel-header">
          <h2>ข้อมูลผู้ใช้</h2>
        </div>

        {userDraft ? (
          <form className="ref-form" onSubmit={saveUser}>
            {/* Avatar Section */}
            <div className="ref-avatar-upload-row">
              <div className="ref-large-avatar-wrap">
                {selectedUserObj ? (
                  <UserAvatar
                    path={avatarPreviewUrl ? null : userDraft.avatarPath}
                    fallbackInitial={getAvatarInitial(selectedUserObj)}
                    bgColor={getAvatarBgColor(selectedUserObj)}
                  />
                ) : (
                  <div className="ref-avatar-initial" style={{ backgroundColor: '#3B82F6' }}>
                    {userDraft.displayName.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
                {avatarPreviewUrl ? (
                  <img alt="preview" src={avatarPreviewUrl} className="ref-avatar-img ref-avatar-img--preview" />
                ) : null}
                <label className="ref-avatar-camera-btn" title="เปลี่ยนรูปโปรไฟล์">
                  <Camera size={14} weight="bold" />
                  <input accept="image/jpeg,image/png,image/webp" onChange={chooseAvatarFile} type="file" />
                </label>
              </div>
            </div>

            {/* Inputs Grid */}
            <div className="ref-form-grid">
              <div className="ref-form-group">
                <label>
                  ชื่อแสดง
                  <input
                    required
                    value={userDraft.displayName}
                    onChange={(event) => setUserDraft({ ...userDraft, displayName: event.target.value })}
                  />
                </label>
              </div>
              <div className="ref-form-group">
                <label>
                  ชื่อเล่น
                  <input
                    placeholder="เช่น รี"
                    value={userDraft.nickname}
                    onChange={(event) => setUserDraft({ ...userDraft, nickname: event.target.value })}
                  />
                </label>
              </div>
              <div className="ref-form-group">
                <label>
                  เบอร์โทร
                  <input
                    placeholder="เช่น 081-234-5678"
                    type="tel"
                    value={userDraft.phone}
                    onChange={(event) => setUserDraft({ ...userDraft, phone: event.target.value })}
                  />
                </label>
              </div>
              <div className="ref-form-group">
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
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {/* Work Sites Section */}
            <fieldset
              className="ref-section"
              disabled={userDraft.role !== 'courier' || !userDraft.isActive}
              aria-label="จุดปฏิบัติงานประจำ"
              role="group"
            >
              <legend className="ref-section-title">
                <h3>จุดปฏิบัติงานประจำ</h3>
                <p className="ref-muted-note">เลือกได้มากกว่าหนึ่งจุด ข้อมูลนี้ใช้ระบุว่าพนักงานแต่ละคนดูแลจุดใดบ้าง</p>
              </legend>

              <div className="ref-worksite-grid">
                {workSites.map((workSite) => {
                  const checked = userDraft.workSiteIds.includes(workSite.id);
                  const isCourier = userDraft.role === 'courier';
                  return (
                    <label
                      className={`ref-worksite-card ${checked ? 'ref-worksite-card--selected' : ''} ${!isCourier ? 'ref-worksite-card--disabled' : ''}`}
                      key={workSite.id}
                    >
                      <input
                        aria-label={workSite.name}
                        checked={checked}
                        disabled={!isCourier || !userDraft.isActive}
                        onChange={(event) => {
                          if (!isCourier) return;
                          setUserDraft({
                            ...userDraft,
                            workSiteIds: event.target.checked
                              ? [...userDraft.workSiteIds, workSite.id]
                              : userDraft.workSiteIds.filter((id) => id !== workSite.id),
                          });
                        }}
                        type="checkbox"
                      />
                      <div className="ref-worksite-card__box">
                        {checked ? <Check size={14} weight="bold" /> : null}
                      </div>
                      <div className="ref-worksite-card__info">
                        <strong>{workSite.code} · {workSite.name}</strong>
                        <small>{workSite.name}</small>
                      </div>
                    </label>
                  );
                })}
              </div>
              {userDraft.role !== 'courier' ? (
                <p className="ref-muted-note">การกำหนดจุดประจำใช้กับบทบาทพนักงานส่งเท่านั้น</p>
              ) : null}
            </fieldset>

            {/* Employee Image Section (Optional) */}
            <div className="ref-section">
              <div className="ref-section-title">
                <h3>รูปพนักงาน (ไม่บังคับ)</h3>
              </div>

              <label className="ref-dropzone">
                <UploadSimple size={26} className="ref-dropzone__icon" />
                <p>คลิกหรือลากไฟล์เพื่ออัปโหลด</p>
                <small>รองรับ JPG, PNG, WEBP ขนาดไม่เกิน 5 MB</small>
                <input aria-label="รูปพนักงาน" accept="image/jpeg,image/png,image/webp" onChange={chooseAvatarFile} type="file" />
              </label>
            </div>

            {/* Status Toggle & Warnings */}
            <div className="ref-form-status-row">
              <label className="ref-toggle-label">
                <input
                  checked={userDraft.isActive}
                  disabled={editingCurrentUser}
                  onChange={(event) => setUserDraft({ ...userDraft, isActive: event.target.checked })}
                  type="checkbox"
                />
                <span>เปิดใช้งานบัญชีนี้</span>
              </label>
              {editingCurrentUser ? (
                <small className="ref-muted-note">บัญชีที่กำลังใช้งานเปลี่ยนบทบาทหรือพักใช้งานตัวเองจากหน้านี้ไม่ได้</small>
              ) : null}
            </div>

            {userError ? <p className="error-text" role="alert">{userError}</p> : null}
            {userSuccess ? <p aria-live="polite" className="success-text">{userSuccess}</p> : null}

            {/* Bottom Actions */}
            <div className="ref-actions-bar">
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
              <button className="primary-button" disabled={savingUser} type="submit" aria-label="บันทึกผู้ใช้">
                {savingUser ? 'กำลังบันทึก...' : 'บันทึกผู้ใช้'}
              </button>
            </div>
          </form>
        ) : (
          <p className="empty-text">เลือกผู้ใช้จากรายการเพื่อแก้ไข</p>
        )}
      </div>
    </div>
  );
}

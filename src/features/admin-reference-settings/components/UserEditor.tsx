import { translateUi, useLanguage } from '../../../i18n';
import { type FormEvent, useMemo, useState } from 'react';
import {
  Check,
  FunnelSimple,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import type { UserProfile, AppRole } from '../../../types/app';
import {
  ROLE_OPTIONS,
  type EmployeeWorkSiteAssignment,
  type UserDraft,
  type WorkSiteOption,
  formatWorkSiteLabel,
} from '../types';
import {
  getErrorMessage,
  resetUserPassword,
  saveUserWithWorkSiteAssignments,
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
    phone: user.phone ?? '',
    role: user.role,
    isActive: user.is_active,
    canCollectShopPayments: user.can_collect_shop_payments,
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

export function UserEditor({
  users,
  workSites,
  workSiteAssignments,
  currentUserId,
  onUserSaved,
}: UserEditorProps) {
  useLanguage();
  const [userDraft, setUserDraft] = useState<UserDraft | null>(() => (
    users.length > 0 ? toUserDraft(users[0], workSiteAssignments, workSites) : null
  ));
  const [userQuery, setUserQuery] = useState('');
  const [userFilter, setUserFilter] = useState<ActiveFilter>('all');
  
  const [savingUser, setSavingUser] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userSuccess, setUserSuccess] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmedPassword, setConfirmedPassword] = useState('');

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

  function chooseUser(user: UserProfile) {
    setUserDraft(toUserDraft(user, workSiteAssignments, workSites));
    setUserError(null);
    setUserSuccess(null);
    setNewPassword('');
    setConfirmedPassword('');
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userDraft) return;

    const displayName = userDraft.displayName.trim();
    if (!displayName) {
      setUserError('กรุณาระบุชื่อผู้ใช้');
      return;
    }
    if (!userDraft.nickname.trim()) {
      setUserError('กรุณาระบุชื่อเล่นสำหรับเข้าสู่ระบบ');
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
        nickname: userDraft.nickname.trim() || null,
        avatar_path: original.avatar_path ?? null,
        phone: userDraft.phone.trim() || null,
        role: isCurrentUser ? original.role : userDraft.role,
        is_active: isCurrentUser ? original.is_active : userDraft.isActive,
        can_collect_shop_payments: userDraft.role === 'courier' && userDraft.canCollectShopPayments,
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

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userDraft || userDraft.id === currentUserId) return;
    if (newPassword.length < 8) {
      setUserError('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
      return;
    }
    if (newPassword !== confirmedPassword) {
      setUserError('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน');
      return;
    }

    setResettingPassword(true);
    setUserError(null);
    setUserSuccess(null);
    try {
      await resetUserPassword(userDraft.id, newPassword);
      setNewPassword('');
      setConfirmedPassword('');
      setUserSuccess(`รีเซ็ตรหัสผ่านของ ${userDraft.displayName} แล้ว`);
    } catch (error) {
      setUserError(getErrorMessage(error));
    } finally {
      setResettingPassword(false);
    }
  }

  const editingCurrentUser = userDraft?.id === currentUserId;
  const userFilterLabel = filterLabel(userFilter);

  return (
    <div className="ref-split-layout">
      {/* Left Column: User List */}
      <div className="ref-left-panel">
        <div className="ref-toolbar">
          <div className="ref-search-input">
            <MagnifyingGlass aria-hidden="true" size={18} />
            <input
              onChange={(event) => setUserQuery(event.target.value)}
              placeholder={translateUi('ค้นหาผู้ใช้')}
              value={userQuery}
            />
          </div>
          <button
            aria-label={translateUi('กรองผู้ใช้: {0}', { 0: userFilterLabel })}
            className={`ref-filter-btn ${userFilter !== 'all' ? 'ref-filter-btn--active' : ''}`}
            onClick={() => setUserFilter(nextFilter(userFilter))}
            title={translateUi('กรองผู้ใช้: {0}', { 0: userFilterLabel })}
            type="button"
          >
            <FunnelSimple size={18} />
          </button>
        </div>

        <div className="ref-list-subhead">
          <span>{translateUi('ทั้งหมด ')}{filteredUsers.length}{translateUi(' รายการ')}</span>
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
              sitesText = translateUi('ประจำ {0}', { 0: assignedWorkSites.map((ws) => ws.name).join(', ') });
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
                  <div className="ref-avatar-initial" style={{ backgroundColor: bgColor }}>{initial}</div>
                </div>

                <div className="ref-user-card__body">
                  <div className="ref-user-card__header">
                    <span className="ref-user-card__email">{user.display_name}</span>
                  </div>
                  <div className="ref-user-card__role">{translateUi(roleLabel(user.role))}</div>
                  <div className="ref-user-card__subtext">{sitesText}</div>
                </div>

                <div className="ref-user-card__badge-wrap">
                  <span className={`ref-pill ${user.is_active ? 'ref-pill--green' : 'ref-pill--amber'}`}>
                    {user.is_active ? translateUi('ใช้งาน') : translateUi('พักใช้งาน')}
                  </span>
                </div>
              </button>
            );
          })}
          {filteredUsers.length === 0 ? <p className="empty-text">{translateUi('ไม่พบผู้ใช้ตามคำค้นหรือเงื่อนไขที่เลือก')}</p> : null}
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
          <h2>{translateUi('ข้อมูลผู้ใช้')}</h2>
        </div>

        {userDraft ? (
          <div className="ref-form">
            <form className="ref-profile-form" id="user-profile-form" onSubmit={saveUser}>
            {/* Inputs Grid */}
            <div className="ref-form-grid">
              <div className="ref-form-group">
                <label>
                  {translateUi('ชื่อแสดง')}<input
                    required
                    value={userDraft.displayName}
                    onChange={(event) => setUserDraft({ ...userDraft, displayName: event.target.value })}
                  />
                </label>
              </div>
              <div className="ref-form-group">
                <label>
                  {translateUi('ชื่อเล่น (ใช้เข้าสู่ระบบ)')}<input
                    placeholder={translateUi('เช่น รี')}
                    required
                    value={userDraft.nickname}
                    onChange={(event) => setUserDraft({ ...userDraft, nickname: event.target.value })}
                  />
                </label>
              </div>
              <div className="ref-form-group">
                <label>
                  {translateUi('เบอร์โทร')}<input
                    placeholder={translateUi('เช่น 081-234-5678')}
                    type="tel"
                    value={userDraft.phone}
                    onChange={(event) => setUserDraft({ ...userDraft, phone: event.target.value })}
                  />
                </label>
              </div>
              <div className="ref-form-group">
                <label>
                  {translateUi('บทบาท')}<select
                    disabled={editingCurrentUser}
                    value={userDraft.role}
                    onChange={(event) => {
                      const role = event.target.value as AppRole;
                      setUserDraft({
                        ...userDraft,
                        role,
                        canCollectShopPayments: role === 'courier' ? userDraft.canCollectShopPayments : false,
                        workSiteIds: role === 'courier' ? userDraft.workSiteIds : [],
                      });
                    }}
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role.value} value={role.value}>
                        {translateUi(role.label)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="ref-form-status-row">
              {userDraft.role === 'courier' ? (
                <label className="ref-toggle-label">
                  <input
                    checked={userDraft.canCollectShopPayments}
                    onChange={(event) => setUserDraft({
                      ...userDraft,
                      canCollectShopPayments: event.target.checked,
                    })}
                    type="checkbox"
                  />
                  <span>{translateUi('รับเงินร้านค้าได้')}</span>
                </label>
              ) : (
                <span className="ref-muted-note">{translateUi('หัวหน้าและแอดมินมีสิทธิ์รับเงินร้านค้าตามบทบาท')}</span>
              )}
            </div>

            {/* Work Sites Section */}
            <div
              className={`ref-section ${userDraft.role !== 'courier' || !userDraft.isActive ? 'ref-section--disabled' : ''}`}
              aria-label={translateUi('จุดปฏิบัติงานประจำ')}
              role="group"
            >
              <div className="ref-section-title">
                <h3>{translateUi('จุดปฏิบัติงานประจำ')}</h3>
                <p className="ref-muted-note">{translateUi('เลือกได้มากกว่าหนึ่งจุด ข้อมูลนี้ใช้ระบุว่าพนักงานแต่ละคนดูแลจุดใดบ้าง')}</p>
              </div>

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
                        <strong>{formatWorkSiteLabel(workSite)}</strong>
                      </div>
                    </label>
                  );
                })}
              </div>
              {userDraft.role !== 'courier' ? (
                <p className="ref-muted-note">{translateUi('การกำหนดจุดประจำใช้กับบทบาทพนักงานส่งเท่านั้น')}</p>
              ) : null}
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
                <span>{translateUi('เปิดใช้งานบัญชีนี้')}</span>
              </label>
              {editingCurrentUser ? (
                <small className="ref-muted-note">{translateUi('บัญชีที่กำลังใช้งานเปลี่ยนบทบาทหรือพักใช้งานตัวเองจากหน้านี้ไม่ได้')}</small>
              ) : null}
            </div>

            </form>

            <form className="ref-section" onSubmit={resetPassword} aria-labelledby="reset-password-title">
              <div className="ref-section-title">
                <h3 id="reset-password-title">{translateUi('รีเซ็ตรหัสผ่าน')}</h3>
                <p>{translateUi('กำหนดรหัสผ่านใหม่ให้ผู้ใช้นี้โดยตรง ผู้ใช้ควรเปลี่ยนรหัสผ่านอีกครั้งหลังเข้าสู่ระบบ')}</p>
              </div>
              {editingCurrentUser ? (
                <p className="ref-muted-note">{translateUi('บัญชีที่กำลังใช้งานไม่สามารถรีเซ็ตรหัสผ่านจากหน้านี้ได้')}</p>
              ) : (
                <div className="ref-password-reset-grid">
                  <label>
                    {translateUi('รหัสผ่านใหม่')}<input
                      autoComplete="new-password"
                      minLength={8}
                      onChange={(event) => setNewPassword(event.target.value)}
                      type="password"
                      value={newPassword}
                    />
                  </label>
                  <label>
                    {translateUi('ยืนยันรหัสผ่านใหม่')}<input
                      autoComplete="new-password"
                      minLength={8}
                      onChange={(event) => setConfirmedPassword(event.target.value)}
                      type="password"
                      value={confirmedPassword}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    disabled={resettingPassword || !newPassword || !confirmedPassword}
                    type="submit"
                  >
                    {resettingPassword ? translateUi('กำลังรีเซ็ต...') : translateUi('รีเซ็ตรหัสผ่าน')}
                  </button>
                </div>
              )}
            </form>

            {userError ? <p className="error-text" role="alert">{translateUi(userError)}</p> : null}
            {userSuccess ? <p aria-live="polite" className="success-text">{translateUi(userSuccess)}</p> : null}

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
                {translateUi('ยกเลิก')}</button>
              <button
                aria-label={translateUi('บันทึกผู้ใช้')}
                className="primary-button"
                disabled={savingUser}
                form="user-profile-form"
                type="submit"
              >
                {savingUser ? translateUi('กำลังบันทึก...') : translateUi('บันทึกผู้ใช้')}
              </button>
            </div>
          </div>
        ) : (
          <p className="empty-text">{translateUi('เลือกผู้ใช้จากรายการเพื่อแก้ไข')}</p>
        )}
      </div>
    </div>
  );
}

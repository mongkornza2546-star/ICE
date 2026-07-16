import { type FormEvent, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { isMissingRpc } from './lib/rpc';
import type { AppRole, UserProfile } from './types/app';

const USER_FIELDS = 'id, code, display_name, phone, role, is_active';
const ICE_TYPE_FIELDS = 'id, code, name, unit, is_active';

const ROLE_OPTIONS: Array<{ value: AppRole; label: string }> = [
  { value: 'courier', label: 'พนักงานส่ง' },
  { value: 'round_lead', label: 'หัวหน้ารอบ' },
  { value: 'admin', label: 'แอดมิน' },
];

interface UserDraft {
  id: string;
  code: string;
  displayName: string;
  phone: string;
  role: AppRole;
  isActive: boolean;
}

interface IceTypeSetting {
  id: string;
  code: string;
  name: string;
  unit: string;
  is_active: boolean;
}

interface IceTypeDraft {
  id: string;
  code: string;
  name: string;
  unit: string;
  isActive: boolean;
}

const EMPTY_ICE_TYPE: IceTypeDraft = {
  id: '',
  code: '',
  name: '',
  unit: '',
  isActive: true,
};

export function AdminReferenceSettings() {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeSetting[]>([]);
  const [userDraft, setUserDraft] = useState<UserDraft | null>(null);
  const [iceTypeDraft, setIceTypeDraft] = useState<IceTypeDraft>(EMPTY_ICE_TYPE);
  const [currentUserId, setCurrentUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [savingUser, setSavingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [userSuccess, setUserSuccess] = useState<string | null>(null);
  const [savingIceType, setSavingIceType] = useState(false);
  const [iceTypeError, setIceTypeError] = useState<string | null>(null);
  const [iceTypeSuccess, setIceTypeSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSettings(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadSettings(isCancelled: () => boolean = () => false) {
    const client = supabase;
    setLoading(true);
    setAuthorized(false);
    setPageError(null);

    if (!client) {
      setPageError('ยังไม่ได้ตั้งค่า Supabase สำหรับหน้านี้');
      setLoading(false);
      return;
    }

    try {
      const { data: authData, error: authError } = await client.auth.getUser();
      if (isCancelled()) return;
      if (authError || !authData.user) {
        setPageError(authError?.message ?? 'ไม่พบบัญชีที่กำลังเข้าใช้งาน');
        return;
      }

      const { data: profileData, error: profileError } = await client
        .from('users')
        .select('id, role, is_active')
        .eq('id', authData.user.id)
        .maybeSingle();
      if (isCancelled()) return;
      if (profileError) {
        setPageError(profileError.message);
        return;
      }

      const profile = profileData as Pick<UserProfile, 'id' | 'role' | 'is_active'> | null;
      if (!profile?.is_active || profile.role !== 'admin') {
        setPageError('หน้านี้ใช้ได้เฉพาะบัญชีแอดมินที่เปิดใช้งาน');
        return;
      }

      const [usersResponse, iceTypesResponse] = await Promise.all([
        client.from('users').select(USER_FIELDS).order('code'),
        client.from('ice_types').select(ICE_TYPE_FIELDS).order('code'),
      ]);
      if (isCancelled()) return;

      const firstError = usersResponse.error ?? iceTypesResponse.error;
      if (firstError) {
        setPageError(firstError.message);
        return;
      }

      const nextUsers = (usersResponse.data ?? []) as UserProfile[];
      const nextIceTypes = (iceTypesResponse.data ?? []) as IceTypeSetting[];
      setCurrentUserId(authData.user.id);
      setUsers(nextUsers);
      setIceTypes(nextIceTypes);
      setUserDraft((current) => {
        const selected = nextUsers.find((user) => user.id === current?.id) ?? nextUsers[0];
        return selected ? toUserDraft(selected) : null;
      });
      setIceTypeDraft((current) => {
        if (!current.id) return current;
        const selected = nextIceTypes.find((iceType) => iceType.id === current.id);
        return selected ? toIceTypeDraft(selected) : EMPTY_ICE_TYPE;
      });
      setAuthorized(true);
    } catch (error) {
      if (!isCancelled()) setPageError(getErrorMessage(error));
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }

  function chooseUser(user: UserProfile) {
    setUserDraft(toUserDraft(user));
    setUserError(null);
    setUserSuccess(null);
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = supabase;
    if (!client || !authorized || !userDraft) return;

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
      const { data, error } = await client
        .from('users')
        .update({
          display_name: displayName,
          phone: userDraft.phone.trim() || null,
          role: isCurrentUser ? original.role : userDraft.role,
          is_active: isCurrentUser ? original.is_active : userDraft.isActive,
        })
        .eq('id', original.id)
        .select(USER_FIELDS)
        .single();

      if (error) {
        setUserError(error.message);
        return;
      }

      const savedUser = data as UserProfile;
      setUsers((current) => current.map((user) => user.id === savedUser.id ? savedUser : user));
      setUserDraft(toUserDraft(savedUser));
      setUserSuccess('บันทึกข้อมูลผู้ใช้แล้ว');
    } catch (error) {
      setUserError(getErrorMessage(error));
    } finally {
      setSavingUser(false);
    }
  }

  function chooseIceType(iceType: IceTypeSetting) {
    setIceTypeDraft(toIceTypeDraft(iceType));
    setIceTypeError(null);
    setIceTypeSuccess(null);
  }

  function startNewIceType() {
    setIceTypeDraft(EMPTY_ICE_TYPE);
    setIceTypeError(null);
    setIceTypeSuccess(null);
  }

  async function saveIceType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = supabase;
    if (!client || !authorized) return;

    const code = iceTypeDraft.code.trim();
    const name = iceTypeDraft.name.trim();
    const unit = iceTypeDraft.unit.trim();
    if (!code || !name || !unit) {
      setIceTypeError('กรุณาระบุรหัส ชื่อ และหน่วยให้ครบ');
      return;
    }

    setSavingIceType(true);
    setIceTypeError(null);
    setIceTypeSuccess(null);
    const payload = { code, name, unit, is_active: iceTypeDraft.isActive };

    try {
      const response = await client.rpc('save_ice_type', {
        p_ice_type_id: iceTypeDraft.id || null,
        p_code: payload.code,
        p_name: payload.name,
        p_unit: payload.unit,
        p_is_active: payload.is_active,
      });

      let savedIceType: IceTypeSetting | null = null;
      if (response.error) {
        if (!isMissingRpc(response.error)) {
          setIceTypeError(response.error.message);
          return;
        }

        const fallbackResponse = iceTypeDraft.id
          ? await client
              .from('ice_types')
              .update(payload)
              .eq('id', iceTypeDraft.id)
              .select(ICE_TYPE_FIELDS)
              .single()
          : await client
              .from('ice_types')
              .insert(payload)
              .select(ICE_TYPE_FIELDS)
              .single();

        if (fallbackResponse.error) {
          setIceTypeError(fallbackResponse.error.message);
          return;
        }

        savedIceType = fallbackResponse.data as IceTypeSetting;
      } else {
        savedIceType = response.data as IceTypeSetting;
      }

      setIceTypes((current) => {
        const exists = current.some((iceType) => iceType.id === savedIceType.id);
        const next = exists
          ? current.map((iceType) => iceType.id === savedIceType.id ? savedIceType : iceType)
          : [...current, savedIceType];
        return next.sort((left, right) => left.code.localeCompare(right.code));
      });
      setIceTypeDraft(toIceTypeDraft(savedIceType));
      setIceTypeSuccess(iceTypeDraft.id ? 'บันทึกชนิดน้ำแข็งแล้ว' : 'เพิ่มชนิดน้ำแข็งแล้ว');
    } catch (error) {
      setIceTypeError(getErrorMessage(error));
    } finally {
      setSavingIceType(false);
    }
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
        <button className="ghost-button" onClick={() => void loadSettings()} type="button">ตรวจสอบอีกครั้ง</button>
      </section>
    );
  }

  const editingCurrentUser = userDraft?.id === currentUserId;

  return (
    <div className="stack">
      <div className="settings-grid">
        <section className="panel stack">
          <div className="panel-header">
            <div><p className="eyebrow">ผู้ใช้ที่มีบัญชีแล้ว</p><h2>จัดการสิทธิ์ผู้ใช้</h2></div>
            <span className="status-badge status-badge--neutral">{users.length} บัญชี</span>
          </div>
          <p className="muted">แก้ไขเฉพาะโปรไฟล์ที่มีอยู่ หน้านี้ไม่สร้างบัญชีหรือรหัสผ่าน</p>
          <div className="settings-list">
            {users.map((user) => (
              <button
                aria-current={userDraft?.id === user.id ? 'true' : undefined}
                className={`round-item ${userDraft?.id === user.id ? 'round-item--selected' : ''}`}
                key={user.id}
                onClick={() => chooseUser(user)}
                type="button"
              >
                <span>{user.code} · {user.display_name}</span>
                <small>{roleLabel(user.role)} · {user.is_active ? 'ใช้งาน' : 'พักใช้งาน'}{user.id === currentUserId ? ' · บัญชีนี้' : ''}</small>
              </button>
            ))}
            {users.length === 0 ? <p className="empty-text">ยังไม่มีโปรไฟล์ผู้ใช้ในระบบ</p> : null}
          </div>
        </section>

        <section className="panel stack">
          <div><p className="eyebrow">โปรไฟล์ผู้ใช้</p><h2>{userDraft ? `แก้ไข ${userDraft.displayName}` : 'เลือกผู้ใช้'}</h2></div>
          {userDraft ? (
            <form className="settings-form" onSubmit={saveUser}>
              <div className="field-grid">
                <label>รหัสผู้ใช้<input readOnly value={userDraft.code} /></label>
                <label>ชื่อที่แสดง<input required value={userDraft.displayName} onChange={(event) => setUserDraft({ ...userDraft, displayName: event.target.value })} /></label>
                <label>เบอร์โทร<input type="tel" value={userDraft.phone} onChange={(event) => setUserDraft({ ...userDraft, phone: event.target.value })} /></label>
                <label>
                  บทบาท
                  <select disabled={editingCurrentUser} value={userDraft.role} onChange={(event) => setUserDraft({ ...userDraft, role: event.target.value as AppRole })}>
                    {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                  </select>
                </label>
              </div>
              <label className="inline-check">
                <input checked={userDraft.isActive} disabled={editingCurrentUser} onChange={(event) => setUserDraft({ ...userDraft, isActive: event.target.checked })} type="checkbox" />
                เปิดใช้งานบัญชี
              </label>
              {editingCurrentUser ? <p className="muted">บัญชีที่กำลังใช้งานเปลี่ยนบทบาทหรือพักใช้งานตัวเองจากหน้านี้ไม่ได้</p> : null}
              {userError ? <p className="error-text" role="alert">{userError}</p> : null}
              {userSuccess ? <p aria-live="polite" className="success-text">{userSuccess}</p> : null}
              <button className="primary-button" disabled={savingUser} type="submit">{savingUser ? 'กำลังบันทึก...' : 'บันทึกผู้ใช้'}</button>
            </form>
          ) : <p className="empty-text">เลือกผู้ใช้จากรายการเพื่อแก้ไข</p>}
        </section>
      </div>

      <div className="settings-grid">
        <section className="panel stack">
          <div className="panel-header">
            <div><p className="eyebrow">ข้อมูลอ้างอิง</p><h2>ชนิดน้ำแข็ง</h2></div>
            <button className="ghost-button" onClick={startNewIceType} type="button">+ ชนิดใหม่</button>
          </div>
          <div className="settings-list">
            {iceTypes.map((iceType) => (
              <button
                aria-current={iceTypeDraft.id === iceType.id ? 'true' : undefined}
                className={`round-item ${iceTypeDraft.id === iceType.id ? 'round-item--selected' : ''}`}
                key={iceType.id}
                onClick={() => chooseIceType(iceType)}
                type="button"
              >
                <span>{iceType.code} · {iceType.name}</span>
                <small>{iceType.unit} · {iceType.is_active ? 'ใช้งาน' : 'พักใช้งาน'}</small>
              </button>
            ))}
            {iceTypes.length === 0 ? <p className="empty-text">ยังไม่มีชนิดน้ำแข็ง เพิ่มรายการแรกได้จากแบบฟอร์ม</p> : null}
          </div>
        </section>

        <section className="panel stack">
          <div><p className="eyebrow">{iceTypeDraft.id ? 'แก้ไขชนิดน้ำแข็ง' : 'ชนิดใหม่'}</p><h2>{iceTypeDraft.id ? iceTypeDraft.name : 'เพิ่มชนิดน้ำแข็ง'}</h2></div>
          <form className="settings-form" onSubmit={saveIceType}>
            <div className="field-grid field-grid--three">
              <label>รหัส<input required value={iceTypeDraft.code} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, code: event.target.value })} /></label>
              <label>ชื่อ<input required value={iceTypeDraft.name} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, name: event.target.value })} /></label>
              <label>หน่วย<input required value={iceTypeDraft.unit} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, unit: event.target.value })} /></label>
            </div>
            <label className="inline-check">
              <input checked={iceTypeDraft.isActive} onChange={(event) => setIceTypeDraft({ ...iceTypeDraft, isActive: event.target.checked })} type="checkbox" />
              เปิดใช้งานชนิดนี้
            </label>
            <p className="muted">รายการที่ไม่ใช้แล้วให้พักใช้งาน ข้อมูลเก่าจะยังคงอยู่ในระบบ</p>
            {iceTypeError ? <p className="error-text" role="alert">{iceTypeError}</p> : null}
            {iceTypeSuccess ? <p aria-live="polite" className="success-text">{iceTypeSuccess}</p> : null}
            <button className="primary-button" disabled={savingIceType} type="submit">{savingIceType ? 'กำลังบันทึก...' : 'บันทึกชนิดน้ำแข็ง'}</button>
          </form>
        </section>
      </div>
    </div>
  );
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

function toIceTypeDraft(iceType: IceTypeSetting): IceTypeDraft {
  return {
    id: iceType.id,
    code: iceType.code,
    name: iceType.name,
    unit: iceType.unit,
    isActive: iceType.is_active,
  };
}

function roleLabel(role: AppRole) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

function getErrorMessage(error: unknown) {
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'เกิดข้อผิดพลาดขณะติดต่อ Supabase';
}

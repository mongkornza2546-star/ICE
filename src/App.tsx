import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { env } from './lib/env';
import { supabase } from './lib/supabase';
import { ManagerRoundControl } from './ManagerRoundControl';
import { ManagerStockControl } from './ManagerStockControl';
import { LocationSettings } from './LocationSettings';
import { ShopSettings } from './ShopSettings';
import { AdminLayout, type AdminView } from './AdminLayout';
import { AdminPreview } from './AdminPreview';
import type {
  DeliveryRound,
  IceTypeOption,
  RoundMemberOption,
  ShopCard,
  ShopCardHistoryEntry,
  ShopRoundStatus,
  UserProfile,
} from './types/app';

const STATUS_LABELS: Record<ShopRoundStatus, string> = {
  pending: 'ยังไม่ส่ง',
  delivered: 'ส่งแล้ว',
  full_bin: 'ถังเต็ม',
  closed_shop: 'ปิดร้าน',
  no_access: 'เข้าไม่ได้',
  issue: 'มีปัญหา',
};

const STATUS_OPTIONS: Array<{ value: ShopRoundStatus; label: string }> = [
  { value: 'delivered', label: 'ส่งแล้ว' },
  { value: 'full_bin', label: 'ถังเต็ม' },
  { value: 'closed_shop', label: 'ปิดร้าน' },
  { value: 'no_access', label: 'เข้าไม่ได้' },
  { value: 'issue', label: 'มีปัญหา' },
];

const PAYMENT_LABELS = {
  unknown: 'ไม่ทราบ',
  paid: 'จ่ายแล้ว',
  unpaid: 'ค้างจ่าย',
} as const;

const ROLE_LABELS = {
  courier: 'พนักงานส่ง',
  round_lead: 'หัวหน้ารอบ',
  admin: 'แอดมิน',
} as const;

const numberPad = ['0', '1', '2', '3', '4', '5', '+'];

interface RoundCreationDraft {
  serviceDate: string;
  name: string;
  memberIds: string[];
  loadedQuantities: Record<string, number>;
}

function todayIsoDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function formatShortTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusTone(status: ShopRoundStatus) {
  switch (status) {
    case 'delivered':
      return 'success';
    case 'full_bin':
    case 'issue':
      return 'warning';
    case 'closed_shop':
    case 'no_access':
      return 'danger';
    default:
      return 'neutral';
  }
}

function paymentTone(status: ShopCard['payment_status']) {
  switch (status) {
    case 'paid':
      return 'success';
    case 'unpaid':
      return 'danger';
    default:
      return 'neutral';
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [bootLoading, setBootLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setBootLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setBootLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setBootLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (new URLSearchParams(window.location.search).get('preview') === 'admin') {
    return <AdminPreview />;
  }

  if (!env.isConfigured) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">Phase 2 Setup</p>
          <h1>ต้องตั้งค่า Supabase ก่อนเริ่มใช้หน้าพนักงาน</h1>
          <p>
            สร้างไฟล์ <code>.env.local</code> จาก <code>.env.example</code> แล้วใส่
            <code>VITE_SUPABASE_URL</code> และ <code>VITE_SUPABASE_ANON_KEY</code>
          </p>
        </section>
      </div>
    );
  }

  if (bootLoading) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">กำลังเริ่มระบบ</p>
          <h1>โหลด session และสิทธิ์ผู้ใช้</h1>
        </section>
      </div>
    );
  }

  return session ? (
    <Workspace session={session} />
  ) : (
    <div className="app-shell">
      <SignInPanel />
    </div>
  );
}

function SignInPanel() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setSubmitting(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
    }

    setSubmitting(false);
  };

  return (
    <section className="panel auth-panel">
      <p className="eyebrow">บัตรร้านส่งน้ำแข็ง</p>
      <h1>เข้าสู่ระบบหน้างาน</h1>
      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          อีเมล
          <input
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="staff@example.com"
            required
          />
        </label>
        <label>
          รหัสผ่าน
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            required
          />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="primary-button" disabled={submitting} type="submit">
          {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
        </button>
      </form>
    </section>
  );
}

function Workspace({ session }: { session: Session }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AdminView>('manager');

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async () => {
      if (!supabase) {
        return;
      }

      setProfileLoading(true);
      setProfileError(null);

      const { data, error } = await supabase
        .from('users')
        .select('id, code, display_name, phone, role, is_active')
        .eq('id', session.user.id)
        .maybeSingle();

      if (cancelled) {
        return;
      }

      if (error) {
        setProfileError(error.message);
      } else {
        setProfile(data as UserProfile | null);
      }

      setProfileLoading(false);
    };

    loadProfile();

    return () => {
      cancelled = true;
    };
  }, [session.user.id]);

  const signOut = async () => {
    await supabase?.auth.signOut();
  };

  if (profileLoading) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">กำลังโหลดสิทธิ์</p>
          <h1>ตรวจข้อมูลผู้ใช้ในระบบ</h1>
        </section>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">โหลดผู้ใช้ไม่สำเร็จ</p>
          <h1>{profileError}</h1>
          <button className="ghost-button" onClick={signOut} type="button">
            ออกจากระบบ
          </button>
        </section>
      </div>
    );
  }

  if (!profile?.is_active) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">บัญชียังไม่พร้อมใช้งาน</p>
          <h1>ผู้ดูแลยังไม่ได้เปิดสิทธิ์บัญชีนี้</h1>
          <p className="muted">
            บัญชี Supabase Auth ถูกสร้างแล้ว แต่ `public.users.is_active` ยังเป็น `false`
          </p>
          <button className="ghost-button" onClick={signOut} type="button">
            ออกจากระบบ
          </button>
        </section>
      </div>
    );
  }

  const canManageRounds = profile.role === 'admin' || profile.role === 'round_lead';
  const currentView = canManageRounds ? activeView : 'delivery';

  const allowedViews: AdminView[] = canManageRounds
    ? profile.role === 'admin'
      ? ['manager', 'delivery', 'locations', 'shops']
      : ['manager', 'delivery']
    : ['delivery'];

  return (
    <AdminLayout
      activeView={currentView}
      allowedViews={allowedViews}
      onNavigate={setActiveView}
      onSignOut={signOut}
      profileLabel={profile.display_name}
    >
      {currentView === 'locations' ? <LocationSettings /> : currentView === 'shops' ? <ShopSettings /> : <RoundWorkspace mode={currentView} profile={profile} />}
    </AdminLayout>
  );
}

function RoundWorkspace({ profile, mode }: { profile: UserProfile; mode: 'manager' | 'delivery' }) {
  const [rounds, setRounds] = useState<DeliveryRound[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeOption[]>([]);
  const [memberOptions, setMemberOptions] = useState<RoundMemberOption[]>([]);
  const [cards, setCards] = useState<ShopCard[]>([]);
  const [selectedRoundId, setSelectedRoundId] = useState<string>('');
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [selectedCardId, setSelectedCardId] = useState<string>('');
  const [loadingRounds, setLoadingRounds] = useState(true);
  const [loadingCards, setLoadingCards] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [roundDraft, setRoundDraft] = useState<RoundCreationDraft>({
    serviceDate: todayIsoDate(),
    name: '',
    memberIds: [],
    loadedQuantities: {},
  });

  const canCreateRound = profile.role === 'admin' || profile.role === 'round_lead';

  useEffect(() => {
    void loadReferenceData();
  }, []);

  useEffect(() => {
    const seededQuantities = Object.fromEntries(
      iceTypes.map((iceType) => [iceType.id, roundDraft.loadedQuantities[iceType.id] ?? 0]),
    );

    setRoundDraft((current) => ({
      ...current,
      loadedQuantities: seededQuantities,
      memberIds:
        current.memberIds.length > 0
          ? current.memberIds
          : canCreateRound && profile.role === 'round_lead'
            ? [profile.id]
            : current.memberIds,
    }));
  }, [iceTypes, canCreateRound, profile.id, profile.role]);

  useEffect(() => {
    if (!selectedRoundId || mode === 'manager') {
      setCards([]);
      setSelectedCardId('');
      return;
    }

    void loadShopCards(selectedRoundId);
  }, [selectedRoundId, mode]);

  const selectedRound = useMemo(
    () => rounds.find((round) => round.id === selectedRoundId) ?? null,
    [rounds, selectedRoundId],
  );

  const buildingOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const card of cards) {
      if (!seen.has(card.building_id)) {
        seen.set(card.building_id, card.building_name);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [cards]);

  const filteredCards = useMemo(
    () =>
      cards.filter((card) =>
        selectedBuildingId ? card.building_id === selectedBuildingId : true,
      ),
    [cards, selectedBuildingId],
  );

  const selectedCard =
    filteredCards.find((card) => card.round_stop_id === selectedCardId) ??
    filteredCards[0] ??
    null;

  useEffect(() => {
    if (!selectedCard && selectedCardId) {
      setSelectedCardId('');
      return;
    }

    if (!selectedCardId && filteredCards.length > 0) {
      setSelectedCardId(filteredCards[0].round_stop_id);
    }
  }, [filteredCards, selectedCard, selectedCardId]);

  async function loadReferenceData() {
    if (!supabase) {
      return;
    }

    setLoadingRounds(true);
    setWorkspaceError(null);

    const [roundsResponse, iceTypesResponse, membersResponse] = await Promise.all([
      supabase
        .from('delivery_rounds')
        .select('id, service_date, name, status, opened_at')
        .order('service_date', { ascending: false })
        .order('opened_at', { ascending: false }),
      supabase
        .from('ice_types')
        .select('id, code, name, unit')
        .eq('is_active', true)
        .order('code'),
      canCreateRound
        ? supabase.rpc('get_assignable_round_members')
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (roundsResponse.error) {
      setWorkspaceError(roundsResponse.error.message);
    } else {
      const nextRounds = (roundsResponse.data ?? []) as DeliveryRound[];
      setRounds(nextRounds);
      setSelectedRoundId((current) => current || nextRounds[0]?.id || '');
    }

    if (iceTypesResponse.error) {
      setWorkspaceError(iceTypesResponse.error.message);
    } else {
      setIceTypes((iceTypesResponse.data ?? []) as IceTypeOption[]);
    }

    if (membersResponse.error) {
      setWorkspaceError(membersResponse.error.message);
    } else {
      setMemberOptions((membersResponse.data ?? []) as RoundMemberOption[]);
    }

    setLoadingRounds(false);
  }

  async function loadShopCards(roundId: string) {
    if (!supabase) {
      return;
    }

    setLoadingCards(true);
    setWorkspaceError(null);

    const { data, error } = await supabase.rpc('get_round_shop_cards', {
      p_round_id: roundId,
      p_building_id: null,
    });

    if (error) {
      setWorkspaceError(error.message);
      setCards([]);
      setLoadingCards(false);
      return;
    }

    const rawCards = (data ?? []) as Array<
      Omit<ShopCard, 'image_url' | 'today_history'> & { today_history: ShopCardHistoryEntry[] | null }
    >;

    const imagePaths = rawCards
      .map((card) => card.image_path)
      .filter((path): path is string => Boolean(path));

    const imageMap = new Map<string, string>();

    if (imagePaths.length > 0) {
      const { data: signedData } = await supabase.storage
        .from('shop-images')
        .createSignedUrls(imagePaths, 3600);

      for (const entry of signedData ?? []) {
        if (entry.path && entry.signedUrl) {
          imageMap.set(entry.path, entry.signedUrl);
        }
      }
    }

    const nextCards = rawCards.map((card) => ({
      ...card,
      image_url: card.image_path ? imageMap.get(card.image_path) ?? null : null,
      today_history: Array.isArray(card.today_history) ? card.today_history : [],
    }));

    setCards(nextCards);
    setLoadingCards(false);
  }

  const handleCreateRound = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setCreateLoading(true);
    setCreateError(null);

    const payload = iceTypes.map((iceType) => ({
      ice_type_id: iceType.id,
      quantity: roundDraft.loadedQuantities[iceType.id] ?? 0,
    }));

    const { data, error } = await supabase.rpc('create_delivery_round', {
      p_service_date: roundDraft.serviceDate,
      p_name: roundDraft.name,
      p_member_ids: roundDraft.memberIds,
      p_loaded_quantities: payload,
    });

    if (error) {
      setCreateError(error.message);
      setCreateLoading(false);
      return;
    }

    const newRoundId = data as string;
    setRoundDraft((current) => ({
      ...current,
      name: '',
      loadedQuantities: Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])),
    }));
    await loadReferenceData();
    setSelectedRoundId(newRoundId);
    setCreateLoading(false);
  };

  if (loadingRounds) {
    return (
      <section className="panel center-panel">
        <p className="eyebrow">กำลังโหลดข้อมูลรอบ</p>
          <h2>ดึงรอบส่งและชนิดน้ำแข็ง</h2>
      </section>
    );
  }

  return (
    <div className="workspace-grid">
      <section className="stack">
        {canCreateRound ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">หัวหน้ารอบ</p>
                <h2>เปิดรอบส่งใหม่</h2>
              </div>
            </div>
            <form className="round-form" onSubmit={handleCreateRound}>
              <div className="field-grid">
                <label>
                  วันที่ให้บริการ
                  <input
                    type="date"
                    value={roundDraft.serviceDate}
                    onChange={(event) =>
                      setRoundDraft((current) => ({
                        ...current,
                        serviceDate: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label>
                  ชื่อรอบ
                  <input
                    placeholder="เช้ามืด / เช้า / รอบเพิ่ม"
                    value={roundDraft.name}
                    onChange={(event) =>
                      setRoundDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    required
                  />
                </label>
              </div>

              <fieldset className="fieldset">
                <legend>ผู้ร่วมรอบ</legend>
                <div className="chip-grid">
                  {memberOptions.map((member) => {
                    const checked = roundDraft.memberIds.includes(member.id);
                    return (
                      <label
                        className={`choice-chip ${checked ? 'choice-chip--selected' : ''}`}
                        key={member.id}
                      >
                        <input
                          checked={checked}
                          hidden
                          onChange={() =>
                            setRoundDraft((current) => ({
                              ...current,
                              memberIds: checked
                                ? current.memberIds.filter((memberId) => memberId !== member.id)
                                : [...current.memberIds, member.id],
                            }))
                          }
                          type="checkbox"
                        />
                        <span>{member.display_name}</span>
                        <small>
                          {ROLE_LABELS[member.role]} · {member.code}
                        </small>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="fieldset">
                <legend>น้ำแข็งยกออกตั้งต้น</legend>
                <div className="field-grid">
                  {iceTypes.map((iceType) => (
                    <label key={iceType.id}>
                      {iceType.name}
                      <input
                        inputMode="numeric"
                        min={0}
                        type="number"
                        value={roundDraft.loadedQuantities[iceType.id] ?? 0}
                        onChange={(event) =>
                          setRoundDraft((current) => ({
                            ...current,
                            loadedQuantities: {
                              ...current.loadedQuantities,
                              [iceType.id]: Math.max(0, Number(event.target.value) || 0),
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </fieldset>

              {createError ? <p className="error-text">{createError}</p> : null}
              <button
                className="primary-button"
                disabled={createLoading || roundDraft.memberIds.length === 0}
                type="submit"
              >
                {createLoading ? 'กำลังเปิดรอบ...' : 'เปิดรอบส่ง'}
              </button>
              <p className="muted">รอบนี้แสดงทุกร้านที่เปิดใช้งาน พนักงานเลือกร้านที่จะไปส่งเองได้ตามหน้างาน</p>
            </form>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">รอบที่เข้าถึงได้</p>
              <h2>เลือกรอบส่ง</h2>
            </div>
          </div>
          <div className="round-list">
            {rounds.map((round) => (
              <button
                className={`round-item ${round.id === selectedRoundId ? 'round-item--selected' : ''}`}
                key={round.id}
                onClick={() => setSelectedRoundId(round.id)}
                type="button"
              >
                <span>{round.name}</span>
                <small>
                  {round.service_date} · {round.status === 'open' ? 'เปิดอยู่' : 'ปิดแล้ว'}
                </small>
              </button>
            ))}
            {rounds.length === 0 ? (
              <p className="empty-text">ยังไม่มีรอบส่งที่บัญชีนี้เข้าถึงได้</p>
            ) : null}
          </div>
        </section>

        {workspaceError ? (
          <section className="panel error-panel">
            <p className="eyebrow">มีข้อผิดพลาด</p>
            <h2>{workspaceError}</h2>
          </section>
        ) : null}
      </section>

      <section className="stack stack--wide">
        {mode === 'manager' ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">หัวหน้ารอบ</p>
                <h2>{selectedRound ? `${selectedRound.name} · ${selectedRound.service_date}` : 'เลือกรอบส่งก่อน'}</h2>
              </div>
            </div>
            <ManagerRoundControl
              onClosed={async () => {
                await loadReferenceData();
              }}
              round={selectedRound}
            />
            <div className="manager-section-divider" />
            <ManagerStockControl round={selectedRound} />
          </section>
        ) : (
        <section className="panel">
          <div className="toolbar">
            <div>
              <p className="eyebrow">บัตรร้าน</p>
              <h2>{selectedRound ? `${selectedRound.name} · ${selectedRound.service_date}` : 'เลือกรอบส่งก่อน'}</h2>
            </div>
            <label className="toolbar-select">
              อาคาร
              <select
                value={selectedBuildingId}
                onChange={(event) => setSelectedBuildingId(event.target.value)}
              >
                <option value="">ทุกอาคาร</option>
                {buildingOptions.map((building) => (
                  <option key={building.id} value={building.id}>
                    {building.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {loadingCards ? (
            <p className="empty-text">กำลังโหลดบัตรร้าน...</p>
          ) : filteredCards.length === 0 ? (
            <p className="empty-text">ไม่มีบัตรร้านในรอบหรืออาคารนี้</p>
          ) : (
            <div className="shop-grid">
              <div className="shop-list">
                {filteredCards.map((card) => (
                  <button
                    className={`shop-card ${selectedCard?.round_stop_id === card.round_stop_id ? 'shop-card--selected' : ''}`}
                    key={card.round_stop_id}
                    onClick={() => setSelectedCardId(card.round_stop_id)}
                    type="button"
                  >
                    <div className="shop-card__header">
                      <strong>
                        {card.sequence_no}. {card.shop_code}
                      </strong>
                      <StatusBadge label={STATUS_LABELS[card.stop_status]} tone={statusTone(card.stop_status)} />
                    </div>
                    <div className="shop-card__title">{card.shop_name}</div>
                    <div className="shop-card__meta">
                      {card.building_name} · {card.floor_or_zone}
                    </div>
                    <div className="badge-row">
                      <StatusBadge
                        label={`การเงิน: ${PAYMENT_LABELS[card.payment_status]}`}
                        tone={paymentTone(card.payment_status)}
                      />
                    </div>
                    <div className="totals-line">
                      {Object.keys(card.today_totals).length > 0
                        ? `รวมวันนี้ ${renderTotals(card.today_totals, iceTypes)}`
                        : 'ยังไม่มียอดวันนี้'}
                    </div>
                  </button>
                ))}
              </div>

              {selectedCard ? (
                <DeliveryPanel
                  iceTypes={iceTypes}
                  key={selectedCard.round_stop_id}
                  onRecorded={async () => {
                    await loadShopCards(selectedRoundId);
                  }}
                  roundIsClosed={selectedRound?.status === 'closed'}
                  shopCard={selectedCard}
                />
              ) : null}
            </div>
          )}
        </section>
        )}
      </section>
    </div>
  );
}

function DeliveryPanel({
  shopCard,
  iceTypes,
  roundIsClosed,
  onRecorded,
}: {
  shopCard: ShopCard;
  iceTypes: IceTypeOption[];
  roundIsClosed: boolean;
  onRecorded: () => Promise<void>;
}) {
  const [selectedIceTypeId, setSelectedIceTypeId] = useState(iceTypes[0]?.id ?? '');
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])),
  );
  const [status, setStatus] = useState<ShopRoundStatus>('delivered');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isDelivery = status === 'delivered';
  const items = useMemo(
    () =>
      iceTypes
        .map((iceType) => ({
          ice_type_id: iceType.id,
          quantity: quantities[iceType.id] ?? 0,
        }))
        .filter((item) => item.quantity > 0),
    [iceTypes, quantities],
  );

  const applyPadValue = (value: string) => {
    if (!selectedIceTypeId) {
      return;
    }

    setQuantities((current) => {
      const existing = current[selectedIceTypeId] ?? 0;
      const nextValue = value === '+' ? existing + 1 : Number(value);
      return {
        ...current,
        [selectedIceTypeId]: nextValue,
      };
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    const trimmedNote = note.trim();

    if (isDelivery && items.length === 0) {
      setError('สถานะส่งแล้วต้องเลือกน้ำแข็งอย่างน้อยหนึ่งประเภท');
      setSubmitting(false);
      return;
    }

    if (!isDelivery && trimmedNote.length === 0) {
      setError('สถานะปัญหาต้องมีหมายเหตุ');
      setSubmitting(false);
      return;
    }

    const { error: recordError } = await supabase.rpc('record_delivery', {
      p_round_stop_id: shopCard.round_stop_id,
      p_items: isDelivery ? items : [],
      p_stop_status: status,
      p_note: trimmedNote || null,
      p_client_recorded_at: new Date().toISOString(),
      p_idempotency_key: crypto.randomUUID(),
    });

    if (recordError) {
      setError(recordError.message);
      setSubmitting(false);
      return;
    }

    setSuccessMessage(isDelivery ? 'บันทึกสำเร็จแล้ว' : 'บันทึกสถานะปัญหาแล้ว');
    setQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    setNote('');
    setStatus('delivered');
    setSubmitting(false);
    await onRecorded();
  };

  return (
    <article className="delivery-panel">
      <div className="delivery-panel__hero">
        {shopCard.image_url ? (
          <img alt={shopCard.shop_name} className="shop-photo" src={shopCard.image_url} />
        ) : (
          <div className="shop-photo shop-photo--placeholder">ไม่มีรูป</div>
        )}
        <div className="delivery-panel__summary">
          <p className="eyebrow">บัตรร้าน</p>
          <h3>
            {shopCard.shop_code} · {shopCard.shop_name}
          </h3>
          <p className="muted">
            {shopCard.building_name} · {shopCard.floor_or_zone}
          </p>
          <div className="badge-row">
            <StatusBadge label={STATUS_LABELS[shopCard.stop_status]} tone={statusTone(shopCard.stop_status)} />
            <StatusBadge
              label={`จ่ายเงิน: ${PAYMENT_LABELS[shopCard.payment_status]}`}
              tone={paymentTone(shopCard.payment_status)}
            />
          </div>
          {shopCard.stop_note ? <p className="note-box">{shopCard.stop_note}</p> : null}
        </div>
      </div>

      <form className="delivery-form" onSubmit={handleSubmit}>
        <div className="toolbar">
          <div>
            <p className="eyebrow">บันทึกใหม่</p>
            <h3>{roundIsClosed ? 'รอบนี้ปิดแล้ว' : 'เลือกน้ำแข็งหรือสถานะร้าน'}</h3>
          </div>
        </div>

        <fieldset className="fieldset">
          <legend>ประเภทน้ำแข็ง</legend>
          <div className="chip-grid">
            {iceTypes.map((iceType) => {
              const active = selectedIceTypeId === iceType.id;
              return (
                <button
                  className={`choice-chip ${active ? 'choice-chip--selected' : ''}`}
                  key={iceType.id}
                  onClick={() => setSelectedIceTypeId(iceType.id)}
                  type="button"
                >
                  <span>{iceType.name}</span>
                  <small>{quantities[iceType.id] ?? 0}</small>
                </button>
              );
            })}
          </div>
          <div className="number-pad">
            {numberPad.map((value) => (
              <button
                className="pad-button"
                key={value}
                onClick={() => applyPadValue(value)}
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
        </fieldset>

        <label>
          สถานะร้าน
          <select value={status} onChange={(event) => setStatus(event.target.value as ShopRoundStatus)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          หมายเหตุ {isDelivery ? '(ถ้ามี)' : '(บังคับ)'}
          <textarea
            onChange={(event) => setNote(event.target.value)}
            placeholder={isDelivery ? 'หมายเหตุเพิ่มเติม' : 'อธิบายเหตุผลที่ส่งไม่ได้'}
            rows={3}
            value={note}
          />
        </label>

        <div className="panel muted-panel">
          <strong>ยอดที่กำลังจะบันทึก</strong>
          <p>{items.length > 0 ? renderTotals(toTotals(items), iceTypes) : 'ยังไม่ได้เลือกน้ำแข็ง'}</p>
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        {successMessage ? <p className="success-text">{successMessage}</p> : null}

        <button className="primary-button" disabled={submitting || roundIsClosed} type="submit">
          {roundIsClosed
            ? 'รอบนี้ปิดแล้ว'
            : submitting
              ? 'กำลังบันทึก...'
              : 'ยืนยันบันทึก'}
        </button>
      </form>

      <section className="history-section">
        <div className="toolbar">
          <div>
            <p className="eyebrow">หลายรอบในวันเดียว</p>
            <h3>ประวัติวันนี้</h3>
          </div>
        </div>
        <div className="history-list">
          {shopCard.today_history.length === 0 ? (
            <p className="empty-text">วันนี้ยังไม่มีรายการ</p>
          ) : (
            shopCard.today_history.map((entry) => (
              <article className="history-item" key={entry.event_id}>
                <strong>
                  {formatShortTime(entry.recorded_at)} · {entry.round_name}
                </strong>
                <span>{renderTotals(entry.items, iceTypes)}</span>
                <small>{entry.recorded_by}</small>
              </article>
            ))
          )}
        </div>
        <div className="panel muted-panel">
          <strong>รวมวันนี้</strong>
          <p>
            {Object.keys(shopCard.today_totals).length > 0
              ? renderTotals(shopCard.today_totals, iceTypes)
              : 'ยังไม่มียอดรวม'}
          </p>
        </div>
      </section>
    </article>
  );
}

function renderTotals(totals: Record<string, number>, iceTypes: IceTypeOption[]) {
  const labels = iceTypes
    .map((iceType) => {
      const value = totals[iceType.id];
      return typeof value === 'number' && value > 0 ? `${iceType.name} ${value}` : null;
    })
    .filter((value): value is string => Boolean(value));

  return labels.length > 0 ? labels.join(' · ') : 'ไม่มีรายการ';
}

function toTotals(items: Array<{ ice_type_id: string; quantity: number }>) {
  return Object.fromEntries(items.map((item) => [item.ice_type_id, item.quantity]));
}

function StatusBadge({ label, tone }: { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}

export default App;

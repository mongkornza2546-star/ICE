import { useEffect, useState } from 'react';
import { Buildings, MapPin, Phone, Storefront, User } from '@phosphor-icons/react';
import { supabase } from '../../lib/supabase';
import { translateUi, useLanguage } from '../../i18n';

type ShopProfile = {
  code: string;
  floor_or_zone: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  buildings: { name: string } | null;
  building_zones: { name: string } | null;
};

export function ReportShopProfile({ shopId, demo, demoArea }: {
  shopId: string; demo: boolean; demoArea?: string | null;
}) {
  useLanguage();
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setProfile(null);
    async function load() {
      try {
        if (!supabase) throw new Error('Supabase unavailable');
        const { data, error: queryError } = await supabase.from('shops')
          .select('code, floor_or_zone, contact_name, contact_phone, buildings(name), building_zones(name)')
          .eq('id', shopId).maybeSingle();
        if (queryError) throw queryError;
        if (!cancelled) setProfile(data as ShopProfile | null);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [shopId, demo, retry]);

  return <section className="executive-shop-profile" aria-label={translateUi('ข้อมูลร้านค้า')}>
    <div className="executive-shop-profile__heading">
      <span><Storefront size={19} aria-hidden="true" />{translateUi('ข้อมูลร้านค้า')}</span>
      {profile?.code ? <small>{translateUi('รหัสร้าน')} {profile.code}</small> : null}
    </div>
    {loading ? <p role="status">{translateUi('กำลังโหลดข้อมูลร้าน…')}</p>
      : error ? <p role="alert">{translateUi('โหลดข้อมูลร้านไม่สำเร็จ')} <button type="button" onClick={() => setRetry((value) => value + 1)}>{translateUi('ลองใหม่')}</button></p>
      : <>
        <div className="executive-shop-profile__location"><Buildings size={22} aria-hidden="true" /><div>
          <small>{translateUi('ตึก / อาคาร')}</small>
          <strong>{profile?.buildings?.name ?? demoArea ?? translateUi('ยังไม่ระบุตึก')}</strong>
        </div></div>
        <dl>
          <div><dt><MapPin size={16} aria-hidden="true" />{translateUi('โซน / ชั้น')}</dt><dd>{[profile?.building_zones?.name, profile?.floor_or_zone].filter((value, index, values) => value && values.indexOf(value) === index).join(' · ') || '—'}</dd></div>
          <div><dt><User size={16} aria-hidden="true" />{translateUi('ผู้ติดต่อ')}</dt><dd>{profile?.contact_name || '—'}</dd></div>
          <div><dt><Phone size={16} aria-hidden="true" />{translateUi('เบอร์โทร')}</dt><dd>{profile?.contact_phone || '—'}</dd></div>
        </dl>
      </>}
  </section>;
}

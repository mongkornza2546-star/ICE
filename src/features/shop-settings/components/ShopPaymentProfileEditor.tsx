import { type FormEvent, useEffect, useState } from 'react';
import { CreditCard } from '@phosphor-icons/react';
import type { ShopPaymentProfileSetting, PaymentTerm, PaymentMethod, CreditDueRule } from '../../../types/app';
import { loadShopPaymentProfile, saveShopPaymentProfile, getErrorMessage } from '../../admin-reference-settings/adminReferenceSettingsService';

interface ShopPaymentProfileEditorProps {
  shopId: string;
  shopName: string;
}

const defaultProfile = (shop_id: string): ShopPaymentProfileSetting => ({
  shop_id,
  allowed_payment_terms: ['immediate'],
  default_payment_term: 'immediate',
  allowed_payment_methods: ['cash', 'bank_transfer', 'qr'],
  default_payment_method: 'cash',
  cash_reference_required: false,
  cash_evidence_required: false,
  bank_transfer_reference_required: true,
  bank_transfer_evidence_required: false,
  qr_reference_required: true,
  qr_evidence_required: false,
  allow_outstanding: false,
  credit_due_rule: null,
  credit_days: null,
  credit_limit: null,
});

export function ShopPaymentProfileEditor({ shopId, shopName }: ShopPaymentProfileEditorProps) {
  const [profile, setProfile] = useState<ShopPaymentProfileSetting>(defaultProfile(shopId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!shopId) return;
    void refreshProfile();
  }, [shopId]);

  async function refreshProfile() {
    setLoading(true);
    setError(null);
    try {
      const data = await loadShopPaymentProfile(shopId);
      if (data) {
        setProfile(data);
      } else {
        setProfile(defaultProfile(shopId));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleTerm(term: PaymentTerm) {
    let nextTerms: PaymentTerm[];
    if (term === 'credit') {
      // Credit is exclusive mode
      nextTerms = ['credit'];
    } else {
      const filtered = profile.allowed_payment_terms.filter((t) => t !== 'credit');
      if (filtered.includes(term)) {
        if (filtered.length > 1) {
          nextTerms = filtered.filter((t) => t !== term);
        } else {
          nextTerms = filtered; // keep at least one
        }
      } else {
        nextTerms = [...filtered, term];
      }
    }

    const defaultTerm = nextTerms.includes(profile.default_payment_term) ? profile.default_payment_term : nextTerms[0];

    const isCredit = nextTerms.includes('credit');
    setProfile({
      ...profile,
      allowed_payment_terms: nextTerms,
      default_payment_term: defaultTerm,
      allow_outstanding: isCredit ? true : profile.allow_outstanding,
      credit_due_rule: isCredit ? (profile.credit_due_rule ?? 'net_days') : null,
      credit_days: isCredit ? (profile.credit_days ?? 30) : null,
    });
  }

  function toggleMethod(method: PaymentMethod) {
    let nextMethods: PaymentMethod[];
    if (profile.allowed_payment_methods.includes(method)) {
      if (profile.allowed_payment_methods.length > 1) {
        nextMethods = profile.allowed_payment_methods.filter((m) => m !== method);
      } else {
        nextMethods = profile.allowed_payment_methods;
      }
    } else {
      nextMethods = [...profile.allowed_payment_methods, method];
    }
    const defaultMethod = nextMethods.includes(profile.default_payment_method) ? profile.default_payment_method : nextMethods[0];
    setProfile({ ...profile, allowed_payment_methods: nextMethods, default_payment_method: defaultMethod });
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const saved = await saveShopPaymentProfile(profile);
      setProfile(saved);
      setSuccess('บันทึกเงื่อนไขการชำระเงินของร้านแล้ว');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="empty-text">กำลังโหลดโปรไฟล์การชำระเงิน...</p>;

  const isCredit = profile.allowed_payment_terms.includes('credit');

  return (
    <section className="shop-payment-profile-section" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border-color, #eee)', paddingTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <CreditCard size={22} weight="duotone" />
        <h3 style={{ margin: 0 }}>เงื่อนไขการชำระเงินของ {shopName}</h3>
      </div>

      <form onSubmit={handleSave}>
        <div className="field-grid" style={{ marginBottom: '1rem' }}>
          <div>
            <label>รูปแบบการชำระเงินที่อนุญาต (Payment Terms)</label>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              <label className="inline-check">
                <input
                  checked={profile.allowed_payment_terms.includes('immediate')}
                  onChange={() => toggleTerm('immediate')}
                  type="checkbox"
                />
                จ่ายทันที (Immediate)
              </label>
              <label className="inline-check">
                <input
                  checked={profile.allowed_payment_terms.includes('end_of_day')}
                  onChange={() => toggleTerm('end_of_day')}
                  type="checkbox"
                />
                เก็บท้ายวัน (End of Day)
              </label>
              <label className="inline-check">
                <input
                  checked={profile.allowed_payment_terms.includes('credit')}
                  onChange={() => toggleTerm('credit')}
                  type="checkbox"
                />
                ร้านเครดิต (Credit)
              </label>
            </div>
          </div>

          <label>
            ค่าเริ่มต้น (Default Term)
            <select
              onChange={(e) => setProfile({ ...profile, default_payment_term: e.target.value as PaymentTerm })}
              value={profile.default_payment_term}
            >
              {profile.allowed_payment_terms.map((term) => (
                <option key={term} value={term}>
                  {term === 'immediate' ? 'จ่ายทันที' : term === 'end_of_day' ? 'เก็บท้ายวัน' : 'เครดิต'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-grid" style={{ marginBottom: '1rem' }}>
          <div>
            <label>ช่องทางการเงินที่รับ (Payment Methods)</label>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              <label className="inline-check">
                <input
                  checked={profile.allowed_payment_methods.includes('cash')}
                  onChange={() => toggleMethod('cash')}
                  type="checkbox"
                />
                เงินสด (Cash)
              </label>
              <label className="inline-check">
                <input
                  checked={profile.allowed_payment_methods.includes('bank_transfer')}
                  onChange={() => toggleMethod('bank_transfer')}
                  type="checkbox"
                />
                โอนเงิน (Transfer)
              </label>
              <label className="inline-check">
                <input
                  checked={profile.allowed_payment_methods.includes('qr')}
                  onChange={() => toggleMethod('qr')}
                  type="checkbox"
                />
                สแกน QR
              </label>
            </div>
          </div>

          <label>
            ช่องทางเริ่มต้น (Default Method)
            <select
              onChange={(e) => setProfile({ ...profile, default_payment_method: e.target.value as PaymentMethod })}
              value={profile.default_payment_method}
            >
              {profile.allowed_payment_methods.map((method) => (
                <option key={method} value={method}>
                  {method === 'cash' ? 'เงินสด' : method === 'bank_transfer' ? 'โอนเงิน' : 'สแกน QR'}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!isCredit ? (
          <div style={{ marginBottom: '1rem' }}>
            <label className="inline-check">
              <input
                checked={profile.allow_outstanding}
                onChange={(e) => setProfile({ ...profile, allow_outstanding: e.target.checked })}
                type="checkbox"
              />
              อนุญาตให้มียอดค้างชำระได้ (หากจ่ายไม่ครบในรอบส่ง)
            </label>
          </div>
        ) : (
          <div className="field-grid" style={{ marginBottom: '1rem', background: 'var(--panel-bg, #f9f9f9)', padding: '1rem', borderRadius: '8px' }}>
            <label>
              กฎวันครบกำหนดชำระ
              <select
                onChange={(e) => setProfile({
                  ...profile,
                  credit_due_rule: e.target.value as CreditDueRule,
                  credit_days: e.target.value === 'end_of_month' ? null : (profile.credit_days ?? 30),
                })}
                value={profile.credit_due_rule ?? 'net_days'}
              >
                <option value="net_days">จำนวนวันเครดิต (Net Days)</option>
                <option value="end_of_month">ครบกำหนดสิ้นเดือน (End of Month)</option>
              </select>
            </label>

            {profile.credit_due_rule === 'net_days' ? (
              <label>
                จำนวนวันเครดิต (วัน)
                <input
                  min="1"
                  onChange={(e) => setProfile({ ...profile, credit_days: Number(e.target.value) || 1 })}
                  type="number"
                  value={profile.credit_days ?? 30}
                />
              </label>
            ) : null}

            <label>
              วงเงินเครดิต (บาท - เว้นว่างหากไม่จำกัด)
              <input
                min="0"
                onChange={(e) => setProfile({ ...profile, credit_limit: e.target.value ? Number(e.target.value) : null })}
                placeholder="เช่น 10000"
                type="number"
                value={profile.credit_limit ?? ''}
              />
            </label>
          </div>
        )}

        {error ? <p className="error-text" role="alert">{error}</p> : null}
        {success ? <p className="success-text" role="polite">{success}</p> : null}

        <button className="primary-button" disabled={saving} type="submit">
          {saving ? 'กำลังบันทึก...' : 'บันทึกโปรไฟล์การชำระเงิน'}
        </button>
      </form>
    </section>
  );
}

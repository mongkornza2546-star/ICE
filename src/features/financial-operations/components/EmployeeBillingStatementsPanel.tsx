import { useCallback, useEffect, useState } from 'react';
import { translateUi, useLanguage } from '../../../i18n';
import { supabase } from '../../../lib/supabase';
import { getErrorMessage } from '../../../lib/errorMessage';
import { invalidateCurrentCollectionContext } from '../../../lib/collectionContext';
import { publishDataChange, subscribeToDataChange } from '../../../lib/dataChange';
import { toBangkokDateString } from '../../../lib/serviceDate';
import type { BillingStatement, ReceivableCharge } from '../types';
import { BillingStatementsSection } from './BillingStatementsSection';

type BillingAccount = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  charges: ReceivableCharge[];
  statements: BillingStatement[];
};

export function EmployeeBillingStatementsPanel({ isActive = true }: { isActive?: boolean }) {
  useLanguage();
  const [accounts, setAccounts] = useState<BillingAccount[]>([]);
  const [shopId, setShopId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const serviceDate = toBangkokDateString();
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');
      const response = await supabase.rpc('get_employee_billing_accounts');
      if (response.error) throw response.error;
      setAccounts((response.data ?? []) as BillingAccount[]);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (isActive) void load(); }, [isActive, load]);
  useEffect(() => {
    if (!isActive) return;
    return subscribeToDataChange(['receivable', 'payment'], () => { void load(); });
  }, [isActive, load]);
  const selected = accounts.find((account) => account.shop_id === shopId);
  const create = async (chargeIds: string[]) => {
    if (!supabase || !selected) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');
    const response = await supabase.rpc('create_billing_statement', {
      p_shop_id: selected.shop_id, p_charge_ids: chargeIds,
    });
    if (response.error) throw response.error;
    const statement = response.data as BillingStatement;
    // Keep the new statement available for reprinting even if the printer fails.
    setAccounts((current) => current.map((account) => account.shop_id === selected.shop_id
      ? { ...account, statements: [statement, ...account.statements] } : account));
    invalidateCurrentCollectionContext(true);
    publishDataChange(['receivable', 'payment']);
    return statement;
  };
  return <section className="financial-ops__section employee-billing">
    <p>{translateUi('ใบวางบิล')} · {translateUi('สรุปยอดรายวัน')} · 57 มม.</p>
    <button disabled={loading} onClick={() => void load()} type="button">{translateUi('รีเฟรชยอดล่าสุด')}</button>
    {error ? <p role="alert">{translateUi(error)}</p> : null}
    {loading ? <p role="status">{translateUi('กำลังโหลด')}</p> : null}
    <label>{translateUi('เลือกร้านค้า')}
      <select disabled={loading} onChange={(event) => setShopId(event.target.value)} value={shopId}>
        <option value="">{translateUi('เลือกร้านค้า')}</option>
        {accounts.map((account) => <option key={account.shop_id} value={account.shop_id}>{account.shop_code} · {account.shop_name}</option>)}
      </select>
    </label>
    {!loading && !error && accounts.length === 0 ? <p>{translateUi('ไม่มีบิลเครดิตสำหรับวางบิล')}</p> : null}
    {selected ? <BillingStatementsSection key={selected.shop_id} busy={loading || !!error} charges={selected.charges}
      dailySummary onCreate={create} serviceDate={serviceDate} statements={selected.statements} /> : null}
  </section>;
}

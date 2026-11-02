import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from '@phosphor-icons/react';
import { translateUi, useLanguage } from '../../../i18n';
import { supabase } from '../../../lib/supabase';
import { getErrorMessage } from '../../../lib/errorMessage';
import { invalidateCurrentCollectionContext } from '../../../lib/collectionContext';
import { publishDataChange, subscribeToDataChange } from '../../../lib/dataChange';
import { toBangkokDateString } from '../../../lib/serviceDate';
import type { BillingStatement, ReceivableCharge } from '../types';
import { BillingStatementsSection } from './BillingStatementsSection';

export type BillingAccount = {
  shop_id: string;
  shop_code: string;
  shop_name: string;
  charges: ReceivableCharge[];
  statements: BillingStatement[];
};

export function EmployeeBillingStatementsPanel({ isActive = true, shopId: focusedShopId, onBack, initialAccount, onAccountChange }: {
  isActive?: boolean;
  shopId?: string;
  onBack?: () => void;
  initialAccount?: BillingAccount | null;
  onAccountChange?: (account: BillingAccount | null) => void;
}) {
  useLanguage();
  const [accounts, setAccounts] = useState<BillingAccount[]>(initialAccount ? [initialAccount] : []);
  const [shopId, setShopId] = useState('');
  const [loading, setLoading] = useState(initialAccount === undefined);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const lifecycle = useRef(0);
  useEffect(() => () => {
    loadRequest.current += 1;
    lifecycle.current += 1;
  }, [focusedShopId, isActive]);
  const serviceDate = toBangkokDateString();
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');
      const response = focusedShopId
        ? await supabase.rpc('get_employee_billing_accounts', { p_shop_id: focusedShopId })
        : await supabase.rpc('get_employee_billing_accounts');
      if (response.error) throw response.error;
      if (request !== loadRequest.current) return;
      const refreshed = (response.data ?? []) as BillingAccount[];
      setAccounts(refreshed);
      if (focusedShopId) onAccountChange?.(refreshed.find((account) => account.shop_id === focusedShopId) ?? null);
    } catch (loadError) {
      if (request === loadRequest.current) setError(getErrorMessage(loadError));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [focusedShopId, onAccountChange]);
  useEffect(() => { if (isActive && initialAccount === undefined) void load(); }, [isActive, load, initialAccount]);
  useEffect(() => {
    if (!isActive) return;
    return subscribeToDataChange(['receivable', 'payment'], () => { void load(); });
  }, [isActive, load]);
  const selected = accounts.find((account) => account.shop_id === (focusedShopId ?? shopId));
  const create = async (chargeIds: string[]) => {
    if (!supabase || !selected) throw new Error('ไม่พบการเชื่อมต่อฐานข้อมูล');
    const epoch = lifecycle.current;
    const response = await supabase.rpc('create_billing_statement', {
      p_shop_id: selected.shop_id, p_charge_ids: chargeIds,
    });
    if (response.error) throw response.error;
    const statement = response.data as BillingStatement;
    // Keep the new statement available for reprinting even if the printer fails.
    setAccounts((current) => current.map((account) => account.shop_id === selected.shop_id
      ? { ...account, statements: [statement, ...account.statements] } : account));
    if (epoch === lifecycle.current) onAccountChange?.({ ...selected, statements: [statement, ...selected.statements] });
    invalidateCurrentCollectionContext(true);
    publishDataChange(['receivable', 'payment']);
    return statement;
  };
  return <section className="financial-ops__section employee-billing">
    {onBack ? <button className="employee-task-choice__back" onClick={onBack} type="button">
      <ArrowLeft aria-hidden="true" size={19} />{translateUi('กลับ')}
    </button> : null}
    <p>{translateUi('ใบวางบิล')} · {translateUi('สรุปยอดรายวัน')} · 57 มม.</p>
    <button disabled={loading} onClick={() => void load()} type="button">{translateUi('รีเฟรชยอดล่าสุด')}</button>
    {error ? <p role="alert">{translateUi(error)}</p> : null}
    {loading ? <p role="status">{translateUi('กำลังโหลด')}</p> : null}
    {focusedShopId ? (selected ? <h2>{selected.shop_code} · {selected.shop_name}</h2> : null) : <label>{translateUi('เลือกร้านค้า')}
      <select disabled={loading} onChange={(event) => setShopId(event.target.value)} value={shopId}>
        <option value="">{translateUi('เลือกร้านค้า')}</option>
        {accounts.map((account) => <option key={account.shop_id} value={account.shop_id}>{account.shop_code} · {account.shop_name}</option>)}
      </select>
    </label>}
    {!loading && !error && (focusedShopId ? !selected : accounts.length === 0) ? <p>{translateUi('ไม่มีบิลเครดิตสำหรับวางบิล')}</p> : null}
    {selected ? <BillingStatementsSection key={selected.shop_id} busy={loading || !!error} charges={selected.charges}
      dailySummary onCreate={create} serviceDate={serviceDate} statements={selected.statements} /> : null}
  </section>;
}

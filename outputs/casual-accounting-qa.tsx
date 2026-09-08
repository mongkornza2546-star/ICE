// Visual QA fixture only. All accounting requests return synthetic local data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccountingPage } from '../src/features/accounting/AccountingPage';
import { supabase } from '../src/lib/supabase';
import '../src/index.css';
const ice = { ice_type_id: 'sample-ice', code: 'ICE', name: 'หลอดเล็ก', unit: 'ถุง' };
if (!supabase) throw new Error('Configured client required for local RPC fixture');
supabase.rpc = async (name, args) => {
  if (name === 'get_accounting_review_queue') return { data: { rows: [], total_count: 0 }, error: null };
  if (name === 'get_accounting_shop_summary') return { data: {
    rows: [], total_count: 0, facets: { shops: [], buildings: [], zones: [] },
    totals: { sales_amount: 0, paid_amount: 0, outstanding_amount: 0, overdue_amount: 0, outstanding_shop_count: 0,
      cumulative_outstanding_amount: 0, cumulative_overdue_amount: 0, cumulative_outstanding_shop_count: 0,
      cash_received_in_period: 0, casual_sales_amount: 110, casual_received_amount: 110, casual_refunded_amount: 0, casual_net_cash: 110, casual_free_count: 1 },
  }, error: null };
  if (name === 'get_accounting_shop_daily_matrix') {
    const days = [];
    for (let date = args.p_from_date; date <= args.p_to_date; date = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)) {
      days.push({ service_date: date, sales_amount: 110, cash_received: 110, cash_refunded: 0, transaction_count: 3,
        items: [{ ice_type_id: ice.ice_type_id, quantity: 1.5, automatic_quantity: 1, free_quantity: 0.5, loose_count: 2, loose_sales_amount: 110, remainder_amount: 10 }] });
    }
    return { data: { rows: [], ice_types: [ice], casual_days: days }, error: null };
  }
  throw new Error(`Unexpected fixture request: ${name}`);
};
createRoot(document.getElementById('root')!).render(<div style={{ padding: 24 }}><p>ข้อมูลจำลองสำหรับตรวจหน้าจอ</p><AccountingPage /></div>);

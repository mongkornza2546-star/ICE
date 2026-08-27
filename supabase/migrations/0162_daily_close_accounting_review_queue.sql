-- Surface resolvable daily-close cash and stock variances in the accounting queue.

create or replace function public.get_accounting_review_queue(
  p_from_date date,
  p_to_date date,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_user() or public.current_app_role() not in ('admin', 'round_lead') then
    raise exception 'Only a round lead or admin can view the accounting review queue';
  elsif p_from_date is null or p_to_date is null or p_to_date < p_from_date
    or p_to_date - p_from_date > 30 then
    raise exception 'Accounting review date range must be between 1 and 31 days';
  elsif p_limit < 1 or p_limit > 1000 or p_offset < 0 then
    raise exception 'Invalid accounting review pagination';
  end if;

  with stock_variance_issues as materialized (
    select
      'stock-variance-' || closure.service_date || '-' || item.id issue_id,
      'STOCK_VARIANCE' issue_type, 'critical' severity, closure.service_date,
      closure.closed_at occurred_at, null::text document_number, null::text shop_name,
      'สต๊อกรวมต่างยอด' title,
      item.name || ' ต่าง ' || item.variance || ' ' || item.unit description,
      item.id source_id, null::uuid delivery_event_id, null::uuid payment_id
    from public.daily_aggregate_stock_closures closure
    cross join lateral public.accounting_aggregate_reconciliation_rows(closure.service_date) item
    where closure.service_date between p_from_date and p_to_date
      and item.count_status = 'complete' and item.variance <> 0
      and not exists (
        select 1
        from public.daily_close_reconciliation_issues reconciliation_issue
        where reconciliation_issue.service_date = closure.service_date
          and reconciliation_issue.issue_type = 'STOCK_VARIANCE'
          and reconciliation_issue.source_id = item.id
      )
  ), daily_close_issues as materialized (
    select
      'daily-close-' || issue.id issue_id,
      issue.issue_type::text issue_type,
      'critical'::text severity,
      issue.service_date,
      issue.created_at occurred_at,
      null::text document_number,
      case issue.issue_type
        when 'CASH_VARIANCE' then app_user.display_name
        else ice.name
      end shop_name,
      case issue.issue_type
        when 'CASH_VARIANCE' then 'เงินสดพนักงานต่างยอด'
        else 'สต๊อกรวมต่างยอด'
      end title,
      case issue.issue_type
        when 'CASH_VARIANCE' then 'ควรส่ง ' || issue.expected_value || ' บาท · นับจริง '
          || issue.actual_value || ' บาท · ต่าง ' || issue.variance_value
          || ' บาท · ' || issue.reason
        else coalesce(ice.name, 'สต๊อก') || ' · ตามระบบ ' || issue.expected_value
          || ' · นับจริง ' || issue.actual_value || ' · ต่าง ' || issue.variance_value
          || ' · ' || issue.reason
      end description,
      issue.id source_id,
      null::uuid delivery_event_id,
      null::uuid payment_id
    from public.daily_close_reconciliation_issues issue
    left join public.users app_user on app_user.id = issue.employee_id
    left join public.ice_types ice
      on issue.issue_type = 'STOCK_VARIANCE' and ice.id = issue.source_id
    where issue.status = 'open'
      and issue.service_date between p_from_date and p_to_date
  ), issues as materialized (
    select
      issue_id, issue_type, severity, service_date, occurred_at, document_number, shop_name,
      title, description, source_id, delivery_event_id, payment_id
    from stock_variance_issues

    union all
    select
      issue_id, issue_type, severity, service_date, occurred_at, document_number, shop_name,
      title, description, source_id, delivery_event_id, payment_id
    from daily_close_issues

    union all
    select
      'unpaid-' || charge.id, 'UNPAID_CHARGE',
      case when charge.payment_term = 'credit' then 'critical' else 'warning' end,
      charge.service_date, charge.created_at, charge.charge_number, shop.name,
      case when charge.payment_term = 'credit' then 'เครดิตเลยกำหนด' else 'รับเงินไม่ครบ' end,
      'คงค้าง ' || (public.effective_delivery_charge_amount(charge.id) - coalesce(allocated.amount, 0)) || ' บาท',
      charge.id, charge.delivery_event_id, null::uuid
    from public.delivery_charges charge
    join public.shops shop on shop.id = charge.shop_id
    left join lateral (select coalesce(sum(allocation.amount), 0) amount
      from public.payment_allocations allocation join public.payments payment on payment.id = allocation.payment_id
      where allocation.charge_id = charge.id and payment.status = 'active') allocated on true
    where charge.service_date between p_from_date and p_to_date and charge.status = 'active'
      and public.effective_delivery_charge_amount(charge.id) > coalesce(allocated.amount, 0)
      and (charge.payment_term <> 'credit' or charge.due_date < (now() at time zone 'Asia/Bangkok')::date)

    union all
    select 'paid-change-' || paid_change.source_kind || '-' || paid_change.source_id,
      'PAID_INVOICE_REVISED', 'critical', paid_change.service_date,
      paid_change.changed_at, paid_change.charge_number, paid_change.shop_name,
      'แก้บิลหลังมีการรับเงิน', paid_change.reason,
      paid_change.source_id, paid_change.delivery_event_id, paid_change.payment_id
    from (
      select distinct on (change.source_kind, change.source_id)
        change.source_kind, change.source_id, charge.service_date, change.changed_at,
        charge.charge_number, shop.name shop_name, change.reason,
        charge.delivery_event_id, change.payment_id
      from public.payment_allocation_changes change
      join public.delivery_charges charge on charge.id = change.from_charge_id
      join public.shops shop on shop.id = charge.shop_id
      where charge.service_date between p_from_date and p_to_date
        and change.before_amount > 0
      order by change.source_kind, change.source_id, change.changed_at, change.id
    ) paid_change

    union all
    select 'refund-' || obligation.id, 'PENDING_REFUND', 'critical', charge.service_date,
      obligation.created_at, charge.charge_number, shop.name, 'รอคืนเงิน',
      obligation.amount || ' บาท · ' || obligation.reason,
      obligation.id, charge.delivery_event_id, obligation.payment_id
    from public.refund_obligations obligation
    join public.delivery_charges charge on charge.id = obligation.source_charge_id
    join public.shops shop on shop.id = charge.shop_id
    where charge.service_date between p_from_date and p_to_date and obligation.status = 'pending'

    union all
    select 'void-rec-' || payment.id, 'VOIDED_RECEIPT', 'warning',
      (payment.recorded_at at time zone 'Asia/Bangkok')::date, coalesce(payment.voided_at, payment.recorded_at),
      payment.receipt_number, shop.name, 'REC ถูก void', coalesce(payment.void_reason, 'ไม่ระบุเหตุผล'),
      payment.id, null::uuid, payment.id
    from public.payments payment join public.shops shop on shop.id = payment.shop_id
    where (payment.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date
      and payment.status = 'voided'

    union all
    select 'replaced-inv-' || charge.id, 'REPLACED_INVOICE', 'warning', charge.service_date,
      coalesce(charge.voided_at, charge.created_at), charge.charge_number, shop.name,
      'INV ถูกแทนที่', coalesce(charge.void_reason, 'มีเอกสารใหม่แทน'),
      charge.id, charge.delivery_event_id, null::uuid
    from public.delivery_charges charge join public.shops shop on shop.id = charge.shop_id
    where charge.service_date between p_from_date and p_to_date and charge.status = 'voided'

    union all
    select 'evidence-' || payment.id, 'MISSING_PAYMENT_EVIDENCE', 'warning',
      (payment.recorded_at at time zone 'Asia/Bangkok')::date, payment.recorded_at,
      payment.receipt_number, shop.name, 'โอน/QR ไม่มีหลักฐาน',
      'ตรวจสอบเลขอ้างอิงและหลักฐานรับเงิน',
      payment.id, null::uuid, payment.id
    from public.payments payment join public.shops shop on shop.id = payment.shop_id
    where (payment.recorded_at at time zone 'Asia/Bangkok')::date between p_from_date and p_to_date
      and payment.status = 'active' and payment.payment_method in ('bank_transfer', 'qr')
      and payment.evidence_path is null
  ), filtered as materialized (
    select * from issues issue
    where nullif(trim(p_filters ->> 'document'), '') is null
      or coalesce(issue.document_number, '') ilike '%' || trim(p_filters ->> 'document') || '%'
      or coalesce(issue.shop_name, '') ilike '%' || trim(p_filters ->> 'document') || '%'
      or (issue.issue_id like 'daily-close-%'
        and issue.description ilike '%' || trim(p_filters ->> 'document') || '%')
  ), page as (
    select * from filtered order by case severity when 'critical' then 0 else 1 end,
      occurred_at desc, issue_id limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(row)) from page row), '[]'::jsonb),
    'total_count', (select count(*) from filtered)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.get_accounting_review_queue(
  date, date, jsonb, integer, integer
) from public;
grant execute on function public.get_accounting_review_queue(
  date, date, jsonb, integer, integer
) to authenticated;

notify pgrst, 'reload schema';

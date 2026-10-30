-- PostgreSQL 16 runs deferred constraint triggers at COMMIT after the RPC's
-- SECURITY DEFINER context has ended. These invariant checks need to read the
-- private ledger as its owner; client roles must never receive table access.
-- Trigger-only functions return no API data and remain non-executable by clients.
alter function public.employee_offline_assert_command_issue_state_v1() security definer;
alter function public.employee_offline_assert_decision_transition_v1() security definer;
alter function public.employee_offline_assert_command_issue_state_v1() set search_path = public, pg_temp;
alter function public.employee_offline_assert_decision_transition_v1() set search_path = public, pg_temp;
revoke all on function public.employee_offline_assert_command_issue_state_v1() from public, anon, authenticated;
revoke all on function public.employee_offline_assert_decision_transition_v1() from public, anon, authenticated;

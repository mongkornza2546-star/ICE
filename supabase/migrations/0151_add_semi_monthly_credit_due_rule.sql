alter type public.credit_due_rule
  add value if not exists 'semi_monthly' after 'weekly';

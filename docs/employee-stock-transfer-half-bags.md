# Employee stock transfer half bags

The withdrawal UI accepts half bags, but `record_employee_stock_transfer` from migration 0015 still decoded all six JSON recordsets as `quantity integer`. Calling it with 7.5 reproduced PostgreSQL error 22P02, `invalid input syntax for type integer: "7.5"`, before any stock write. Migration 0028 upgraded ledger storage and general stock movements but omitted this employee RPC.

Migration 0183 replaces that RPC with numeric decoding and validates positive multiples of 0.5 before storage can round them. Existing authorization, stock checks, locking, audit data and idempotent replay remain in the function.

Validation: `node --test tests/employee-stock-transfer.integration.test.mjs tests/employee-stock-damage.integration.test.mjs` passed all four tests. The original function failed the same 7.5 regression. The fixed function preserves 7.5 + 0.5, moves truck stock from 130 to 122, prevents duplicate retries and rejects changed retry payloads, unsupported fractions and overdraw. Tests run the SQL function in PGlite with isolated stock/auth fixtures; production has not been tested or migrated.

Deployment: apply `supabase/migrations/0183_employee_stock_transfer_half_bags.sql` to the application database. No frontend rebuild is required. This workspace has a project reference but no available Supabase CLI or database connector for applying the migration in this session.

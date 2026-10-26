# Casual POS building selector — 0259

The selling-building dropdown read every active building, including internal
event compatibility buildings left active after an event ended. It did not use
the separation already applied in location settings (`isEventLocationCode`).

Apply `supabase/migrations/0259_casual_pos_exclude_event_buildings.sql` after 0258.
It filters `EVENT-` and `SITE-EVENT-` codes, ignoring case and surrounding spaces,
from `get_casual_transaction_context().sale_buildings`. Regular active buildings
remain selectable. Event locations are managed through the event workflow.
No frontend release is required; reopen the casual POS after applying the SQL.

The migration only changes the selector. Historical sales, receipts, building
names in history, stock, cash recipients and permissions are preserved. It can
be rerun and rejects an unexpected RPC definition instead of silently skipping.

Validation: `node --test tests/casual-measured-transactions.integration.test.mjs`.
The regression reproduces the old selector including an active legacy event
building, applies the migration twice, checks normal buildings and inactive
buildings, and compares every other context field with the original result.

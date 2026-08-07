# ADR 0001: Normalize sales-space ownership

- Status: Proposed
- Date: 2026-08-07

## Context

`shops.id` identifies a tenant/business and owns delivery, billing, payment, pricing, rental-tank, and audit history. `shops.government_shop_code` currently carries a different concept: the reusable physical sales-space code. Migration `0135` prevents two active shops from claiming one normalized code, but the mutable text field cannot retain occupancy history or identify the space served by a historical delivery.

The transition must not merge shops, invent chronology, or weaken the Phase 1 guard.

## Proposed decision

1. A shop may have at most one current sales space. This preserves the current product model and is enforced in the database. A sales space may likewise have at most one current shop.
2. Cutover uses dual read/write for one verified release. `government_shop_code` remains the legacy compatibility field and the `0135` index remains active. One database module owns synchronization so save, import, deactivation, and direct writes cannot diverge.
3. Occupancy uses explicit `current` and `ended` states. `started_on` and `ended_on` may be null when the source does not know them. Each boundary has `exact`, `approximate`, or `unknown` precision, and each row records provenance. Generic `created_at` or `updated_at` values are never promoted to business dates.
4. New `round_stops` capture nullable `occupancy_id`, `sales_space_id`, and an immutable sales-space code snapshot. The reporting question is: “Which physical sales space did this delivery stop serve at the time the daily work was created?” Existing stops remain null because the old mutable shop field cannot answer that safely. A column-specific `before update` trigger rejects changes to these three snapshot columns while allowing delivery status, note, and audit fields to keep their existing update behavior.
5. Backfill creates one stable sales space per normalized nonblank legacy code. Every unambiguous active claim becomes a current occupancy. Inactive claims become ended legacy relationships with unknown boundaries; multiple inactive claims are retained without inferred ordering. Active duplicates or one code spanning multiple zones abort with an actionable report.
6. Sales-space lifecycle is `active`, `temporarily_unavailable`, or `retired`; “occupied” is derived from current occupancy and is never stored. A retired space is permanent and its code cannot be reassigned to a new identity. Temporarily unavailable spaces cannot receive a new occupancy.
7. `sales_spaces.zone_id` is authoritative for physical location. During compatibility, assigning a current occupancy synchronizes the shop’s legacy location fields. Directly moving an occupied shop to another zone is rejected. Moving an occupied sales space requires an explicit audited operation that updates both the space and its current shop.
8. A sales-space handover or shop deactivation is blocked while that shop has a stop in an open delivery round. Round creation and ownership mutation serialize on the same transaction-level advisory lock, derived from the fixed key `sales-space-ownership-topology`. Daily and special round creators acquire it before enumerating active shops; assign, release, handover, deactivation, save, and import acquire it before checking open rounds or changing occupancy. Direct `shops` mutations are revoked once those writers are routed through the module, because acquiring the lock inside the mutation statement is too late to guarantee a fresh concurrency snapshot. This preserves the current round-stop model: the old tenant cannot remain deliverable after releasing the space, and the new tenant joins delivery work only when a new round is created. Rebuilding an in-progress round is out of scope for this transition.

## Invariants

- `shops.id` remains the tenant identity; sharing or reusing a space transfers no financial or operational records.
- Sales-space codes are globally unique after trim and case normalization.
- A current occupancy is unique by both `sales_space_id` and `shop_id`.
- A current occupancy references an active shop and an active sales space in the same authoritative zone.
- Ending a current occupancy never deactivates or deletes the shop automatically.
- Deactivating a shop ends its current occupancy only after existing rental-tank rules pass.
- Backfill is repeatable and records provenance; it never guesses dates or chronology.
- Delivery space snapshots are immutable after creation, enforced independently from mutable stop workflow fields.
- An open round cannot outlive a shop-to-space handover for one of its stops.
- Round-stop creation and ownership mutation acquire the same topology lock before their first topology read or write.

## Transition

1. Run `supabase/scripts/audit_sales_space_backfill.sql` and resolve blocking result sets.
2. Add normalized tables, constraints, policies, audit support, the snapshot-column immutability trigger, and a deterministic backfill while `0135` remains active.
3. Add the shared topology lock to the ownership module and both daily and special round creators. Route `save_shop`, `deactivate_shop`, `import_shop_catalog`, and legacy writer signatures through the module; preserve their signatures and grants, then revoke direct `shops` mutation paths.
4. Verify the serialization with two-connection tests covering both commit orders between round creation and handover/deactivation.
5. Add the normalized selector/history read model to Shop Settings.
6. Reconcile normalized current occupancy against `government_shop_code` and alert on any mismatch.
7. After one verified release and a rollback exercise, stop legacy writes. Removing the field or Phase 1 index requires a later ADR and forward migration.

## Rollback

During dual write, rollback switches readers back to `shops.government_shop_code`; the Phase 1 trigger/index continue enforcing safe active reuse. Normalized rows remain additive and are not deleted. Any rollback migration must disable normalized writers before removing compatibility triggers.

## Consequences

- New schema and compatibility logic add transition complexity, but concentrate assignment rules behind one database seam.
- Existing delivery history cannot be retroactively attributed to sales spaces without a trustworthy external source.
- The one-space-per-shop rule would need a later ADR and constraint change if multi-space tenants become a real requirement.

## Approval needed

Before changing the schema, confirm four product-facing choices: one current space per shop, one-release dual write, delivery snapshots carrying occupancy plus sales-space identity, and blocking handovers/deactivation while an open round still contains the shop.

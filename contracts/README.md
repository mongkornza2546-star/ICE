# Employee offline contract v1

`employee-offline-v1.fixtures.json` is the shared compatibility fixture for the
browser and PostgreSQL implementations. It freezes one command and applied
result for every command type, the stable sync error vocabulary, and the
cross-runtime fingerprint values. A change to an existing v1 field, result,
error code, canonical value, or digest is a breaking change. Add a new contract
version instead of rewriting a queued command's meaning.

## Fingerprint algorithm

The identifier is `sha256-canonical-json-v1`.

1. Convert money to integer minor units (satang). Every number passed to the
   canonical serializer must be a JavaScript-safe integer.
2. Use ASCII letters, digits, and underscores for object keys so JavaScript and
   PostgreSQL `C` ordering are identical.
3. Sort arrays that represent sets by their documented identifier. Preserve
   arrays where order carries meaning, such as command sequence.
4. Serialize JSON with object keys in bytewise ascending order, no whitespace,
   and array order preserved.
5. Hash the UTF-8 bytes with SHA-256 and encode as lowercase hexadecimal.

The payment-profile value includes `credit_suspended` because that flag changes
whether PostgreSQL permits a credit delivery. Human-readable suspension reasons
are deliberately excluded.

Applied result DTOs are closed schemas. Invoice and receipt snapshots contain
the complete immutable financial fields needed for printing and must agree with
their enclosing delivery/payment result. Delivery quantities use positive
half-unit increments, and each monetary line is rounded to satang before totals
are summed, matching PostgreSQL `numeric(12,2)` delivery lines.

Envelope timestamps use a real proleptic-Gregorian date in years 0001–9999,
hours 00–23, and an explicit `Z` or numeric offset no larger than 15:59. The
shared invalid-timestamp fixtures keep browser and PostgreSQL parsing aligned.

The TypeScript implementation is in `src/offline/fingerprints.ts`. The SQL
implementation is migration `0148_employee_offline_contract_v1.sql`. Both are
checked against the same expected canonical strings and digests.

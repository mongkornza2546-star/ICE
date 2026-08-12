import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../supabase/migrations/0149_employee_offline_ledger_schema.sql', import.meta.url),
  'utf8',
);
const fixtures = JSON.parse(
  readFileSync(new URL('../contracts/employee-offline-v1.fixtures.json', import.meta.url), 'utf8'),
);

const USER_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '40000000-0000-4000-8000-000000000002';
const OTHER_ROUND_ID = '50000000-0000-4000-8000-000000000002';
const HASH = 'a'.repeat(64);

function envelopeFor(command) {
  return {
    schemaVersion: command.schemaVersion,
    payloadVersion: command.payloadVersion,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    deviceId: command.deviceId,
    ownerId: command.ownerId,
    serviceDate: command.serviceDate,
    sequence: command.sequence,
    clientRecordedAt: command.clientRecordedAt,
  };
}

async function insertCommand(db, command, overrides = {}) {
  const row = {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    deviceId: command.deviceId,
    userId: command.ownerId,
    serviceDate: command.serviceDate,
    sequence: command.sequence,
    commandType: command.type,
    schemaVersion: command.schemaVersion,
    payloadVersion: command.payloadVersion,
    payload: command.payload,
    payloadHash: HASH,
    clientRecordedAt: command.clientRecordedAt,
    status: 'received',
    result: null,
    issueId: null,
    resolutionVersion: 0,
    appliedAt: null,
    ...overrides,
  };

  await db.query(
    `insert into public.employee_offline_commands (
      command_id, idempotency_key, device_id, user_id, service_date, sequence,
      command_type, schema_version, payload_version, payload, payload_hash,
      client_recorded_at, status, result, issue_id, resolution_version, applied_at
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::bigint,
      $7::public.employee_offline_command_type, $8::integer, $9::integer,
      $10::jsonb, $11::text, $12::timestamptz,
      $13::public.employee_offline_command_status, $14::jsonb, $15::uuid,
      $16::bigint, $17::timestamptz
    )`,
    [
      row.commandId,
      row.idempotencyKey,
      row.deviceId,
      row.userId,
      row.serviceDate,
      row.sequence,
      row.commandType,
      row.schemaVersion,
      row.payloadVersion,
      JSON.stringify(row.payload),
      row.payloadHash,
      row.clientRecordedAt,
      row.status,
      row.result === null ? null : JSON.stringify(row.result),
      row.issueId,
      row.resolutionVersion,
      row.appliedAt,
    ],
  );
}

async function expectDeferredTransactionRejection(db, operation, pattern) {
  await db.exec('begin');
  try {
    await operation();
    await assert.rejects(db.exec('commit'), pattern);
  } finally {
    await db.exec('rollback');
  }
}

test('employee offline ledger schema, helpers, transitions, and access controls', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());

  await db.exec(`
    create role anon;
    create role authenticated;
    create table public.users (
      id uuid primary key,
      display_name text not null,
      is_active boolean not null default true
    );
    create table public.delivery_rounds (
      id uuid primary key,
      service_date date not null
    );
    create table public.round_stops (
      id uuid primary key,
      round_id uuid not null references public.delivery_rounds(id)
    );
    create table public.collection_runs (
      id uuid primary key,
      service_date date not null
    );
    create function public.set_updated_at()
    returns trigger
    language plpgsql
    as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$;
    insert into public.users (id, display_name) values
      ('${USER_ID}', 'Courier One'),
      ('${OTHER_USER_ID}', 'Lead Two');
    insert into public.delivery_rounds (id, service_date) values
      ('50000000-0000-4000-8000-000000000001', '2026-08-11'),
      ('${OTHER_ROUND_ID}', '2026-08-11');
    insert into public.round_stops (id, round_id) values
      ('80000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001'),
      ('80000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001');
    insert into public.collection_runs (id, service_date) values
      ('a0000000-0000-4000-8000-000000000001', '2026-08-11');
  `);
  await db.exec(migration);

  await t.test('freezes SQL error codes against the shared cross-runtime fixture', async () => {
    const result = await db.query(`
      select enum.enumlabel as code
      from pg_enum enum
      join pg_type type on type.oid = enum.enumtypid
      join pg_namespace namespace on namespace.oid = type.typnamespace
      where namespace.nspname = 'public'
        and type.typname = 'employee_offline_error_code'
      order by enum.enumsortorder
    `);
    assert.deepEqual(result.rows.map(({ code }) => code), fixtures.errorCodes);

    for (const code of fixtures.errorCodes) {
      const error = await db.query(
        `select public.employee_offline_error_v1(
          $1::public.employee_offline_error_code,
          'Stable message',
          '{"fixture":true}'::jsonb
        ) as error`,
        [code],
      );
      assert.deepEqual(error.rows[0].error, {
        code,
        message: 'Stable message',
        details: { fixture: true },
      });
    }

    const nestedNulls = await db.query(`
      select public.employee_offline_error_v1(
        'PRICE_CHANGED',
        'Price changed',
        '{"expected":null,"nested":{"actual":null},"array":[null,{"x":null}]}'::jsonb
      ) as error
    `);
    assert.deepEqual(nestedNulls.rows[0].error.details, {
      expected: null,
      nested: { actual: null },
      array: [null, { x: null }],
    });
    await assert.rejects(
      db.query(
        `select public.employee_offline_error_v1(
          null::public.employee_offline_error_code,
          'Missing code'
        )`,
      ),
      /require a stable error code/,
    );
  });

  await t.test('parses the closed envelope and keeps unsupported versions representable', async () => {
    const envelope = envelopeFor(fixtures.commands[0]);
    const parsed = await db.query(
      `select * from public.employee_offline_parse_envelope_v1($1::jsonb)`,
      [JSON.stringify(envelope)],
    );
    assert.equal(parsed.rows[0].schema_version, 1);
    assert.equal(parsed.rows[0].command_id, envelope.commandId);
    assert.equal(Number(parsed.rows[0].sequence), envelope.sequence);

    const futureVersion = await db.query(
      `select schema_version
       from public.employee_offline_parse_envelope_v1($1::jsonb)`,
      [JSON.stringify({ ...envelope, schemaVersion: 2 })],
    );
    assert.equal(futureVersion.rows[0].schema_version, 2);

    await assert.rejects(
      db.query(
        `select * from public.employee_offline_parse_envelope_v1($1::jsonb)`,
        [JSON.stringify({ ...envelope, extra: true })],
      ),
      /does not match the v1 allowlist/,
    );
    await assert.rejects(
      db.query(
        `select * from public.employee_offline_parse_envelope_v1($1::jsonb)`,
        [JSON.stringify({ ...envelope, sequence: 9007199254740992 })],
      ),
      /positive safe integer/,
    );

    for (const timestamp of fixtures.invalidTimestamps) {
      await assert.rejects(
        db.query(
          `select * from public.employee_offline_parse_envelope_v1($1::jsonb)`,
          [JSON.stringify({ ...envelope, clientRecordedAt: timestamp })],
        ),
        /clientRecordedAt must be an ISO timestamp with an offset/,
      );
    }

    for (const timestamp of fixtures.validTimestampBoundaries) {
      const boundary = await db.query(
        `select client_recorded_at
         from public.employee_offline_parse_envelope_v1($1::jsonb)`,
        [JSON.stringify({ ...envelope, clientRecordedAt: timestamp })],
      );
      assert.equal(boundary.rows.length, 1);
    }

    for (const serviceDate of fixtures.invalidServiceDates) {
      await assert.rejects(
        db.query(
          `select * from public.employee_offline_parse_envelope_v1($1::jsonb)`,
          [JSON.stringify({ ...envelope, serviceDate })],
        ),
        /serviceDate must be a valid YYYY-MM-DD date/,
      );
    }

    for (const serviceDate of fixtures.validServiceDateBoundaries) {
      const boundary = await db.query(
        `select service_date
         from public.employee_offline_parse_envelope_v1($1::jsonb)`,
        [JSON.stringify({ ...envelope, serviceDate })],
      );
      assert.equal(boundary.rows.length, 1);
    }
  });

  await t.test('enforces command identity and one issue for the matching command', async () => {
    const command = fixtures.commands[0];
    await insertCommand(db, command);

    await assert.rejects(
      insertCommand(db, fixtures.commands[2], {
        status: 'applied',
        result: { fabricated: true },
        resolutionVersion: 999,
        appliedAt: '2026-08-11T03:00:01.000Z',
      }),
      /must enter the ledger as received/,
    );

    await assert.rejects(insertCommand(db, command), /unique constraint/);
    await assert.rejects(
      insertCommand(db, fixtures.commands[1], {
        commandId: '10000000-0000-4000-8000-000000000201',
        idempotencyKey: command.idempotencyKey,
      }),
      /unique constraint/,
    );
    await assert.rejects(
      insertCommand(db, fixtures.commands[1], {
        commandId: '10000000-0000-4000-8000-000000000202',
        idempotencyKey: '20000000-0000-4000-8000-000000000202',
        sequence: command.sequence,
      }),
      /unique constraint/,
    );

    await assert.rejects(
      db.query(
        `insert into public.offline_sync_issues (
          command_id, device_id, user_id, service_date, command_type, payload,
          error_code, error_message, scope_type, round_id
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::date,
          'stock_transfer', $5::jsonb, 'ROUND_CLOSED', 'Closed', 'round', $6::uuid
        )`,
        [
          command.commandId,
          command.deviceId,
          OTHER_USER_ID,
          command.serviceDate,
          JSON.stringify(command.payload),
          command.payload.roundId,
        ],
      ),
      /foreign key constraint/,
    );

    const unlinkedCommand = fixtures.commands[1];
    await insertCommand(db, unlinkedCommand);
    await assert.rejects(
      db.query(
        `update public.employee_offline_commands
         set status = 'applied', result = null, applied_at = now()
         where command_id = $1::uuid`,
        [unlinkedCommand.commandId],
      ),
      /employee_offline_commands_state_check/,
    );
    await assert.rejects(
      db.query(
        `insert into public.offline_sync_issues (
          command_id, device_id, user_id, service_date, command_type, payload,
          error_code, error_message, status, scope_type, round_id,
          decided_by, decided_at, decision_reason
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::date,
          'stock_return', $5::jsonb, 'ROUND_CLOSED', 'Closed',
          'discard_approved', 'round', $6::uuid, $7::uuid, now(), 'Fabricated'
        )`,
        [
          unlinkedCommand.commandId,
          unlinkedCommand.deviceId,
          unlinkedCommand.ownerId,
          unlinkedCommand.serviceDate,
          JSON.stringify(unlinkedCommand.payload),
          unlinkedCommand.payload.roundId,
          OTHER_USER_ID,
        ],
      ),
      /must be inserted open and undecided/,
    );
    await assert.rejects(
      db.query(
        `insert into public.offline_sync_issues (
          command_id, device_id, user_id, service_date, command_type, payload,
          error_code, error_message, scope_type, round_id
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::date,
          'stock_return', $5::jsonb, 'ROUND_CLOSED', 'Closed', 'round', $6::uuid
        )`,
        [
          unlinkedCommand.commandId,
          unlinkedCommand.deviceId,
          unlinkedCommand.ownerId,
          unlinkedCommand.serviceDate,
          JSON.stringify(unlinkedCommand.payload),
          unlinkedCommand.payload.roundId,
        ],
      ),
      /must be linked by its matching command/,
    );

    await expectDeferredTransactionRejection(
      db,
      async () => {
        const mismatched = await db.query(
          `insert into public.offline_sync_issues (
            command_id, device_id, user_id, service_date, command_type, payload,
            error_code, error_message, scope_type, round_id
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::date,
            'stock_return', '{"tampered":true}'::jsonb,
            'ROUND_CLOSED', 'Closed', 'round', $5::uuid
          ) returning id`,
          [
            unlinkedCommand.commandId,
            unlinkedCommand.deviceId,
            unlinkedCommand.ownerId,
            unlinkedCommand.serviceDate,
            unlinkedCommand.payload.roundId,
          ],
        );
        await db.query(
          `update public.employee_offline_commands
           set status = 'conflict', issue_id = $2::uuid
           where command_id = $1::uuid`,
          [unlinkedCommand.commandId, mismatched.rows[0].id],
        );
      },
      /payload must match its immutable command payload/,
    );

    await expectDeferredTransactionRejection(
      db,
      async () => {
        const wrongScope = await db.query(
          `insert into public.offline_sync_issues (
            command_id, device_id, user_id, service_date, command_type, payload,
            error_code, error_message, scope_type, round_id
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::date,
            'stock_return', $5::jsonb, 'ROUND_CLOSED', 'Closed', 'round', $6::uuid
          ) returning id`,
          [
            unlinkedCommand.commandId,
            unlinkedCommand.deviceId,
            unlinkedCommand.ownerId,
            unlinkedCommand.serviceDate,
            JSON.stringify(unlinkedCommand.payload),
            OTHER_ROUND_ID,
          ],
        );
        await db.query(
          `update public.employee_offline_commands
           set status = 'conflict', issue_id = $2::uuid
           where command_id = $1::uuid`,
          [unlinkedCommand.commandId, wrongScope.rows[0].id],
        );
      },
      /stock issue scope does not match its command/,
    );

    await assert.rejects(
      db.query(
        `insert into public.offline_sync_issues (
          command_id, device_id, user_id, service_date, command_type, payload,
          error_code, error_message, scope_type
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::date,
          'stock_return', $5::jsonb, 'ROUND_CLOSED', 'Closed', 'round'
        )`,
        [
          unlinkedCommand.commandId,
          unlinkedCommand.deviceId,
          unlinkedCommand.ownerId,
          unlinkedCommand.serviceDate,
          JSON.stringify(unlinkedCommand.payload),
        ],
      ),
      /offline_sync_issues_scope_check/,
    );

    await db.exec('begin');
    try {
      const adminOnlyIssue = await db.query(
        `insert into public.offline_sync_issues (
          command_id, device_id, user_id, service_date, command_type, payload,
          error_code, error_message, scope_type
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::date,
          'stock_return', $5::jsonb, 'INVALID_PAYLOAD', 'Invalid payload',
          'admin_only'
        ) returning id`,
        [
          unlinkedCommand.commandId,
          unlinkedCommand.deviceId,
          unlinkedCommand.ownerId,
          unlinkedCommand.serviceDate,
          JSON.stringify(unlinkedCommand.payload),
        ],
      );
      await db.query(
        `update public.employee_offline_commands
         set status = 'conflict', issue_id = $2::uuid
         where command_id = $1::uuid`,
        [unlinkedCommand.commandId, adminOnlyIssue.rows[0].id],
      );
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }

    await db.exec('begin');
    let issue;
    try {
      issue = await db.query(
        `insert into public.offline_sync_issues (
          command_id, device_id, user_id, service_date, command_type, payload,
          error_code, error_message, scope_type, round_id
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::date,
          'stock_transfer', $5::jsonb, 'ROUND_CLOSED', 'Closed', 'round', $6::uuid
        ) returning id`,
        [
          command.commandId,
          command.deviceId,
          command.ownerId,
          command.serviceDate,
          JSON.stringify(command.payload),
          command.payload.roundId,
        ],
      );
      await db.query(
        `update public.employee_offline_commands
         set status = 'conflict', issue_id = $2::uuid,
             resolution_version = 999
         where command_id = $1::uuid`,
        [command.commandId, issue.rows[0].id],
      );
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }

    await assert.rejects(
      db.query(
        `update public.employee_offline_commands
         set payload = payload || '{"unexpected":true}'::jsonb
         where command_id = $1::uuid`,
        [command.commandId],
      ),
      /identity and payload are immutable/,
    );

    const stored = await db.query(
      `select status, issue_id, resolution_version
       from public.employee_offline_commands
       where command_id = $1::uuid`,
      [command.commandId],
    );
    assert.equal(stored.rows[0].status, 'conflict');
    assert.equal(stored.rows[0].issue_id, issue.rows[0].id);
    assert.ok(Number(stored.rows[0].resolution_version) > 0);
    assert.notEqual(Number(stored.rows[0].resolution_version), 999);

    await assert.rejects(
      db.query(
        `update public.offline_sync_issues
         set payload = '{"tampered":true}'::jsonb, round_id = $2::uuid
         where id = $1::uuid`,
        [issue.rows[0].id, OTHER_ROUND_ID],
      ),
      /Invalid employee offline issue status transition/,
    );
  });

  await t.test('allows only audited retry then applied transitions', async () => {
    const command = fixtures.commands[0];
    const issue = await db.query(
      `select id from public.offline_sync_issues where command_id = $1::uuid`,
      [command.commandId],
    );

    await assert.rejects(
      db.query(
        `update public.employee_offline_commands
         set status = 'applied', result = '{}'::jsonb, applied_at = now()
         where command_id = $1::uuid`,
        [command.commandId],
      ),
      /Invalid employee offline command status transition/,
    );

    await expectDeferredTransactionRejection(
      db,
      async () => {
        await db.query(
          `insert into public.offline_sync_issue_decisions (
            issue_id, command_id, decision, reason, decided_by,
            resolution_version
          ) values (
            $1::uuid, $2::uuid, 'retry', 'Fabricated audit', $3::uuid, 4242
          )`,
          [issue.rows[0].id, command.commandId, OTHER_USER_ID],
        );
      },
      /audit record must match its final command transition/,
    );

    await expectDeferredTransactionRejection(
      db,
      async () => {
        await db.query(
          `update public.offline_sync_issues
           set status = 'retry_requested', decided_by = $2::uuid,
               decided_at = now(), decision_reason = 'Missing audit row'
           where id = $1::uuid`,
          [issue.rows[0].id, OTHER_USER_ID],
        );
        await db.query(
          `update public.employee_offline_commands
           set status = 'retry_requested'
           where command_id = $1::uuid`,
          [command.commandId],
        );
      },
      /requires a matching append-only audit record/,
    );

    await db.exec('begin');
    try {
      await db.query(
        `update public.offline_sync_issues
         set status = 'retry_requested', decided_by = $2::uuid,
             decided_at = now(), decision_reason = 'Source data corrected'
         where id = $1::uuid`,
        [issue.rows[0].id, OTHER_USER_ID],
      );
      await db.query(
        `update public.employee_offline_commands
         set status = 'retry_requested'
         where command_id = $1::uuid`,
        [command.commandId],
      );
      await db.query(
        `insert into public.offline_sync_issue_decisions (
          issue_id, command_id, decision, reason, decided_by, decided_at,
          resolution_version
        )
        select
          issue.id,
          issue.command_id,
          'retry',
          issue.decision_reason,
          issue.decided_by,
          issue.decided_at,
          command.resolution_version
        from public.offline_sync_issues issue
        join public.employee_offline_commands command
          on command.command_id = issue.command_id
        where issue.id = $1::uuid`,
        [issue.rows[0].id],
      );
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }

    await assert.rejects(
      db.query(
        `update public.offline_sync_issues
         set status = 'open', payload = '{"tampered":true}'::jsonb,
             round_id = $2::uuid
         where id = $1::uuid`,
        [issue.rows[0].id, OTHER_ROUND_ID],
      ),
      /payload and authorization scope are immutable/,
    );

    await assert.rejects(
      db.query(
        `update public.offline_sync_issues
         set status = 'open', decided_by = null, decided_at = null,
             decision_reason = null
         where id = $1::uuid`,
        [issue.rows[0].id],
      ),
      /decision metadata cannot be cleared or rewritten/,
    );

    const decision = await db.query(
      `select id from public.offline_sync_issue_decisions where issue_id = $1::uuid`,
      [issue.rows[0].id],
    );
    await assert.rejects(
      db.query(
        `update public.offline_sync_issue_decisions
         set reason = 'Rewritten' where id = $1::uuid`,
        [decision.rows[0].id],
      ),
      /append-only/,
    );

    await db.exec('begin');
    try {
      await db.query(
        `update public.offline_sync_issues
         set status = 'resolved_applied'
         where id = $1::uuid`,
        [issue.rows[0].id],
      );
      await db.query(
        `update public.employee_offline_commands
         set status = 'applied', result = '{"ok":true}'::jsonb,
             applied_at = now()
         where command_id = $1::uuid`,
        [command.commandId],
      );
      await db.exec('commit');
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }

    const applied = await db.query(
      `select command.status, command.result, issue.status as issue_status
       from public.employee_offline_commands command
       join public.offline_sync_issues issue on issue.id = command.issue_id
       where command.command_id = $1::uuid`,
      [command.commandId],
    );
    assert.equal(applied.rows[0].status, 'applied');
    assert.deepEqual(applied.rows[0].result, { ok: true });
    assert.equal(applied.rows[0].issue_status, 'resolved_applied');
    const auditCount = await db.query(
      `select count(*)::integer as count
       from public.offline_sync_issue_decisions
       where issue_id = $1::uuid`,
      [issue.rows[0].id],
    );
    assert.equal(auditCount.rows[0].count, 1);
  });

  await t.test('uses a private rollout mode and revokes every direct data path', async () => {
    await db.query(
      `insert into public.employee_offline_user_access (user_id)
       values ($1::uuid)`,
      [USER_ID],
    );
    const access = await db.query(
      `select mode, mode_changed_at, drain_cutoff_at
       from public.employee_offline_user_access where user_id = $1::uuid`,
      [USER_ID],
    );
    assert.equal(access.rows[0].mode, 'disabled');
    assert.equal(access.rows[0].drain_cutoff_at, null);

    const disabled = await db.query(
      `select public.employee_offline_rollout_allows_command_v1(
        $1::uuid, now()
      ) as allowed`,
      [USER_ID],
    );
    assert.equal(disabled.rows[0].allowed, false);

    await db.query(
      `update public.employee_offline_user_access set mode = 'enabled'
       where user_id = $1::uuid`,
      [USER_ID],
    );
    const enabled = await db.query(
      `select public.employee_offline_rollout_allows_command_v1(
        $1::uuid, now() + interval '1 day'
      ) as allowed`,
      [USER_ID],
    );
    assert.equal(enabled.rows[0].allowed, true);

    const draining = await db.query(
      `update public.employee_offline_user_access set mode = 'drain_only'
       where user_id = $1::uuid
       returning mode_changed_at, drain_cutoff_at`,
      [USER_ID],
    );
    assert.equal(
      new Date(draining.rows[0].mode_changed_at).getTime(),
      new Date(draining.rows[0].drain_cutoff_at).getTime(),
    );
    const drainChecks = await db.query(
      `select
         public.employee_offline_rollout_allows_command_v1(
           $1::uuid, $2::timestamptz
         ) as queued_allowed,
         public.employee_offline_rollout_allows_command_v1(
           $1::uuid, $2::timestamptz + interval '1 microsecond'
         ) as new_rejected`,
      [USER_ID, draining.rows[0].drain_cutoff_at],
    );
    assert.equal(drainChecks.rows[0].queued_allowed, true);
    assert.equal(drainChecks.rows[0].new_rejected, false);

    await db.query(
      `update public.employee_offline_user_access
       set drain_cutoff_at = drain_cutoff_at + interval '1 day'
       where user_id = $1::uuid`,
      [USER_ID],
    );
    const guardedCutoff = await db.query(
      `select drain_cutoff_at from public.employee_offline_user_access
       where user_id = $1::uuid`,
      [USER_ID],
    );
    assert.equal(
      new Date(guardedCutoff.rows[0].drain_cutoff_at).getTime(),
      new Date(draining.rows[0].drain_cutoff_at).getTime(),
    );

    await db.query(
      `update public.employee_offline_user_access set mode = 'disabled'
       where user_id = $1::uuid`,
      [USER_ID],
    );
    const disabledAgain = await db.query(
      `select mode, drain_cutoff_at,
         public.employee_offline_rollout_allows_command_v1(
           $1::uuid, '-infinity'::timestamptz
         ) as allowed
       from public.employee_offline_user_access where user_id = $1::uuid`,
      [USER_ID],
    );
    assert.equal(disabledAgain.rows[0].mode, 'disabled');
    assert.equal(disabledAgain.rows[0].drain_cutoff_at, null);
    assert.equal(disabledAgain.rows[0].allowed, false);

    const security = await db.query(`
      select relname, relrowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in (
          'employee_offline_user_access',
          'employee_offline_commands',
          'offline_sync_issues',
          'offline_sync_issue_decisions'
        )
      order by relname
    `);
    assert.equal(security.rows.length, 4);
    assert.ok(security.rows.every(({ relrowsecurity }) => relrowsecurity));

    const leakedTablePrivileges = await db.query(`
      with roles(role_name) as (
        values ('anon'), ('authenticated')
      ), protected_tables(table_name) as (
        values
          ('employee_offline_user_access'),
          ('employee_offline_commands'),
          ('offline_sync_issues'),
          ('offline_sync_issue_decisions')
      ), privileges(privilege_name) as (
        values
          ('select'), ('insert'), ('update'), ('delete'),
          ('truncate'), ('references'), ('trigger')
      )
      select role_name, table_name, privilege_name
      from roles
      cross join protected_tables
      cross join privileges
      where has_table_privilege(
        role_name,
        'public.' || table_name,
        privilege_name
      )
    `);
    assert.deepEqual(leakedTablePrivileges.rows, []);

    const leakedFunctionPrivileges = await db.query(`
      with roles(role_name) as (
        values ('anon'), ('authenticated')
      ), protected_functions(signature) as (
        values
          ('public.employee_offline_jsonb_has_exact_keys_v1(jsonb,text[])'),
          ('public.employee_offline_error_v1(public.employee_offline_error_code,text,jsonb)'),
          ('public.employee_offline_raise_v1(public.employee_offline_error_code,text,jsonb)'),
          ('public.employee_offline_parse_envelope_v1(jsonb)'),
          ('public.employee_offline_rollout_allows_command_v1(uuid,timestamp with time zone)'),
          ('public.employee_offline_next_resolution_version_v1()'),
          ('public.employee_offline_guard_rollout_update_v1()'),
          ('public.employee_offline_guard_command_update_v1()'),
          ('public.employee_offline_guard_issue_update_v1()'),
          ('public.employee_offline_reject_decision_change_v1()'),
          ('public.employee_offline_assert_command_issue_state_v1()'),
          ('public.employee_offline_assert_decision_transition_v1()')
      )
      select role_name, signature
      from roles
      cross join protected_functions
      where has_function_privilege(role_name, signature, 'execute')
    `);
    assert.deepEqual(leakedFunctionPrivileges.rows, []);

    const leakedSequencePrivileges = await db.query(`
      with roles(role_name) as (
        values ('anon'), ('authenticated')
      ), privileges(privilege_name) as (
        values ('usage'), ('select'), ('update')
      )
      select role_name, privilege_name
      from roles
      cross join privileges
      where has_sequence_privilege(
        role_name,
        'public.employee_offline_resolution_version_seq',
        privilege_name
      )
    `);
    assert.deepEqual(leakedSequencePrivileges.rows, []);

    const sequence = await db.query(`
      select max_value
      from pg_sequences
      where schemaname = 'public'
        and sequencename = 'employee_offline_resolution_version_seq'
    `);
    assert.equal(Number(sequence.rows[0].max_value), Number.MAX_SAFE_INTEGER);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(
          db.query('select * from public.employee_offline_commands'),
          /permission denied/,
        );
      } finally {
        await db.exec('reset role');
      }
    }
  });
});

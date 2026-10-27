import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
export async function createVatDatabase(beforeVat, beforeUncheckedWriterRevoked) {
 const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
 try {
 await db.exec(`    drop schema public cascade;
    drop schema if exists auth cascade;
    drop schema if exists storage cascade;
    create schema public;
    create schema auth;
    create schema storage;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role; exception when duplicate_object then null; end $$;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      raw_app_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null,
      metadata jsonb,
      unique (bucket_id, name)
    );
    create function storage.foldername(text) returns text[] language sql immutable as $$
      select string_to_array($1, '/')
    $$;
    alter table storage.objects enable row level security;
    create publication supabase_realtime;
`);
 const directory = new URL('../../supabase/migrations/', import.meta.url);
 for (const name of readdirSync(directory).filter(name => /^(?:\d{4}|\d{14})_.+\.sql$/.test(name)).sort()) {
   if (name.startsWith('0216_')) await beforeVat?.(db);
   if (name.startsWith('0217_')) await beforeUncheckedWriterRevoked?.(db);
   const sql = readFileSync(new URL(name, directory), 'utf8');
   try { await db.exec(sql); }
   catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
 }
 return db;
 } catch (error) { await db.close(); throw error; }
}

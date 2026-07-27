-- Nicknames are used as the staff-facing sign-in name.
-- Empty nicknames remain unset; non-empty values must be unique regardless of case.

create unique index if not exists users_nickname_login_key
  on public.users (lower(btrim(nickname)))
  where nickname is not null and btrim(nickname) <> '';

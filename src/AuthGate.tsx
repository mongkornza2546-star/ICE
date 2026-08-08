import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { env } from './lib/env';
import { getRecoverableSessionNotice } from './lib/authErrors';
import { supabase } from './lib/supabase';
import { RoleRouter } from './RoleRouter';

export function AuthGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);

  const recoverSession = useCallback(async (message: string | null | undefined) => {
    const notice = getRecoverableSessionNotice(message);
    if (!notice) return false;

    setAuthNotice(notice);
    await supabase?.auth.signOut();
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!supabase) {
      setBootLoading(false);
      return () => {
        cancelled = true;
      };
    }

    void supabase.auth.getSession().then(async ({ data, error }) => {
      if (cancelled) return;
      if (await recoverSession(error?.message)) {
        if (!cancelled) setBootLoading(false);
        return;
      }

      setSession(data.session ?? null);
      setBootLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (nextSession) {
        setAuthNotice(null);
      }
      setSession(nextSession);
      setBootLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (!env.isConfigured) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">Phase 2 Setup</p>
          <h1>ต้องตั้งค่า Supabase ก่อนเริ่มใช้หน้าพนักงาน</h1>
          <p>
            สร้างไฟล์ <code>.env.local</code> จาก <code>.env.example</code> แล้วใส่
            <code>VITE_SUPABASE_URL</code> และ <code>VITE_SUPABASE_ANON_KEY</code>
          </p>
        </section>
      </div>
    );
  }

  if (bootLoading) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">กำลังเริ่มระบบ</p>
          <h1>โหลด session และสิทธิ์ผู้ใช้</h1>
        </section>
      </div>
    );
  }

  return session ? (
    <RoleRouter onRecoverableSessionError={recoverSession} session={session} />
  ) : (
    <div className="app-shell">
      <SignInPanel notice={authNotice} />
    </div>
  );
}

function SignInPanel({ notice }: { notice: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setSubmitting(true);
    setError(null);

    const isEmail = username.includes('@');
    const { error: signInError } = isEmail
      ? await supabase.auth.signInWithPassword({ email: username, password })
      : await signInWithNickname(username, password);

    if (signInError) {
      setError(signInError.message);
    }

    setSubmitting(false);
  };

  return (
    <section className="panel auth-panel">
      <p className="eyebrow">บัตรร้านส่งน้ำแข็ง</p>
      <h1>เข้าสู่ระบบหน้างาน</h1>
      {notice ? <p className="muted">{notice}</p> : null}
      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          ชื่อเล่นหรืออีเมล
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="เช่น เมย์ หรือ staff@example.com"
            required
          />
        </label>
        <label>
          รหัสผ่าน
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            required
          />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="primary-button" disabled={submitting} type="submit">
          {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
        </button>
      </form>
    </section>
  );
}

async function signInWithNickname(nickname: string, password: string) {
  if (!supabase) return { error: new Error('ยังไม่ได้ตั้งค่า Supabase สำหรับหน้านี้') };

  const { data, error: invokeError } = await supabase.functions.invoke('nickname-password-sign-in', {
    body: { nickname, password },
  });
  const session = data?.session;
  if (invokeError || !session) {
    return { error: invokeError ?? new Error('ชื่อเล่นหรือรหัสผ่านไม่ถูกต้อง') };
  }
  return supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
}

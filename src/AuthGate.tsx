import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { env } from './lib/env';
import { getRecoverableSessionNotice } from './lib/authErrors';
import { supabase } from './lib/supabase';
import { clearCachedUserProfile } from './lib/userProfileCache';
import { RoleRouter } from './RoleRouter';
import { LanguageSwitcher, localizeErrorMessage, useLanguage, translateUi } from './i18n';

export function AuthGate() {
  const { language, t } = useLanguage();
  const [session, setSession] = useState<Session | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const lastSessionUserId = useRef<string | null>(null);

  const recoverSession = useCallback(async (message: string | null | undefined) => {
    const notice = getRecoverableSessionNotice(message);
    if (!notice) return false;

    setAuthNotice(notice);
    if (lastSessionUserId.current) clearCachedUserProfile(lastSessionUserId.current);
    lastSessionUserId.current = null;
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

      lastSessionUserId.current = data.session?.user.id ?? null;
      setSession(data.session ?? null);
      setBootLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (nextSession) {
        setAuthNotice(null);
        lastSessionUserId.current = nextSession.user.id;
      } else if (lastSessionUserId.current) {
        clearCachedUserProfile(lastSessionUserId.current);
        lastSessionUserId.current = null;
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
          <LanguageSwitcher className="language-switcher--auth" />
          <p className="eyebrow">Phase 2 Setup</p>
          <h1>{t('setupRequired')}</h1>
          <p>
            {t('setupFile')} <code>.env.local</code> {t('setupFrom')} <code>.env.example</code> {t('setupThen')}
            <code>VITE_SUPABASE_URL</code> {t('setupAnd')} <code>VITE_SUPABASE_ANON_KEY</code>
          </p>
        </section>
      </div>
    );
  }

  if (bootLoading) {
    return (
      <div className="app-shell">
        <section className="panel center-panel">
          <p className="eyebrow">{t('booting')}</p>
          <h1>{t('loadingSession')}</h1>
        </section>
      </div>
    );
  }

  return session ? (
    <RoleRouter key={session.user.id} onRecoverableSessionError={recoverSession} session={session} />
  ) : (
    <div className="app-shell">
      <SignInPanel notice={authNotice && language === 'my' ? localizeErrorMessage(authNotice) : authNotice} />
    </div>
  );
}

function SignInPanel({ notice }: { notice: string | null }) {
  const { language, t } = useLanguage();
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
      setError(language === 'my' ? localizeErrorMessage(signInError.message) : signInError.message);
    }

    setSubmitting(false);
  };

  return (
    <section className="panel auth-panel">
      <LanguageSwitcher className="language-switcher--auth" />
      <p className="eyebrow">{t('brand')}</p>
      <h1>{t('loginTitle')}</h1>
      {notice ? <p className="muted">{notice}</p> : null}
      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          {t('usernameOrEmail')}
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t('usernameExample')}
            required
          />
        </label>
        <label>
          {t('password')}
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            required
          />
        </label>
        {error ? <p className="error-text">{translateUi(error)}</p> : null}
        <button className="primary-button" disabled={submitting} type="submit">
          {submitting ? t('signingIn') : t('signIn')}
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
  if (invokeError) {
    const response = 'context' in invokeError ? invokeError.context : null;
    const body = response instanceof Response ? await response.json().catch(() => null) : null;
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : invokeError.message;
    return { error: new Error(message) };
  }

  const session = data?.session;
  if (!session) return { error: new Error('ระบบเข้าสู่ระบบไม่ส่งข้อมูล session กลับมา') };
  return supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
}

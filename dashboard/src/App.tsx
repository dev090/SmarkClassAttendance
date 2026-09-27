import { useCallback, useEffect, useState } from 'react';
import { getStoredUser, getToken, setSession } from './api';
import { Home } from './components/Home';
import { LiveView } from './components/LiveView';
import { Login } from './components/Login';
import { SummaryView } from './components/SummaryView';
import type { User } from './types';

type View = { name: 'home' } | { name: 'live'; sessionId: string } | { name: 'summary'; sessionId: string };

/** Views are mirrored into the URL hash so a refresh mid-demo lands on the same screen. */
function viewFromHash(): View {
  const m = /^#(live|summary)\/([\w-]+)$/.exec(location.hash);
  if (m) return { name: m[1] as 'live' | 'summary', sessionId: m[2]! };
  return { name: 'home' };
}
const hashFor = (v: View): string => (v.name === 'home' ? '' : `#${v.name}/${v.sessionId}`);

export function App() {
  const [user, setUser] = useState<User | null>(() => (getToken() ? getStoredUser<User>() : null));
  const [view, setViewState] = useState<View>(viewFromHash);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => {
    try {
      return (localStorage.getItem('smartclass.theme') as 'light' | 'dark' | null) ?? null;
    } catch {
      return null;
    }
  });

  const setView = useCallback((v: View) => {
    setViewState(v);
    const h = hashFor(v);
    if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
  }, []);

  useEffect(() => {
    const onHash = (): void => setViewState(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem('smartclass.theme', theme);
      else localStorage.removeItem('smartclass.theme');
    } catch {
      /* ignore */
    }
  }, [theme]);

  if (!user) return <Login onLogin={setUser} />;

  const logout = (): void => {
    setSession(null, null);
    setUser(null);
    setView({ name: 'home' });
  };
  const isDark = theme === 'dark' || (theme === null && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          SmartClass
        </div>
        {view.name !== 'home' && (
          <button className="btn sm" onClick={() => setView({ name: 'home' })}>
            ← Home
          </button>
        )}
        <span className="grow" />
        <button className="btn sm" onClick={() => setTheme(isDark ? 'light' : 'dark')} aria-label="Toggle theme">
          {isDark ? 'Light' : 'Dark'}
        </button>
        <span className="small ink2">{user.name}</span>
        <button className="btn sm" onClick={logout}>
          Sign out
        </button>
      </header>
      {view.name === 'home' && (
        <Home user={user} onOpenLive={(id) => setView({ name: 'live', sessionId: id })} onOpenSummary={(id) => setView({ name: 'summary', sessionId: id })} />
      )}
      {view.name === 'live' && <LiveView sessionId={view.sessionId} onEnded={(id) => setView({ name: 'summary', sessionId: id })} />}
      {view.name === 'summary' && <SummaryView sessionId={view.sessionId} onHome={() => setView({ name: 'home' })} />}
    </>
  );
}

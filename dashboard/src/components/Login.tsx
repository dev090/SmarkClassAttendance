import { useState, type FormEvent } from 'react';
import { api, setSession } from '../api';
import type { User } from '../types';

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('prof@unb.ca');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (r.user.role === 'student') {
        setError('Students use the SmartClass mobile app. Sign in with a professor account.');
        return;
      }
      setSession(r.token, r.user);
      onLogin(r.user);
    } catch (err) {
      setError((err as Error).message === 'invalid credentials' ? 'Wrong email or password.' : `Could not sign in: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand">
          <span className="dot" />
          SmartClass
        </div>
        <h1>Professor sign in</h1>
        <p className="small muted" style={{ margin: 0 }}>
          Device-presence-assisted attendance. Seeded demo account: prof@unb.ca / password.
        </p>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="username" required />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" required />
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

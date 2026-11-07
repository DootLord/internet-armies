import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { authRequest, type User } from './authApi';

export function AuthGate({ children }: { children: ReactNode }) {
  const enabled = import.meta.env.VITE_AUTH_ENABLED === 'true';
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!enabled) return;
    authRequest('session')
      .then((result) => setUser(result.user ?? null))
      .catch(() => setMessage('Cannot connect to the account service. Please reload and try again.'))
      .finally(() => setLoading(false));
  }, [enabled]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await authRequest(register ? 'register' : 'login', { email, password });
      setPassword('');
      if (register) {
        setRegister(false);
        setMessage(result.message ?? 'Account created. You can now sign in.');
      } else setUser(result.user ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await authRequest('logout', null);
      // The current game is local and shared by the page, not by the account.
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Logout failed.');
      setBusy(false);
    }
  }

  if (!enabled) return children;
  if (loading) return <div className="auth-page">Connecting to account service…</div>;
  if (user) return <>{children}<div className="auth-account">Signed in as {user.email} · Local prototype <button disabled={busy} onClick={logout}>Sign out</button>{message && <span role="alert">{message}</span>}</div></>;
  return (
    <main className="auth-page">
      <form className="auth-form" onSubmit={submit}>
        <h1>Internet Armies</h1>
        <p>Sign in to your account. The game world is still a local prototype.</p>
        <label>Email <input type="email" autoComplete="email" maxLength={254} required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password <input type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : undefined} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {message && <p role="status">{message}</p>}
        <button type="submit" disabled={busy}>{register ? 'Create account' : 'Sign in'}</button>
        <button type="button" disabled={busy} onClick={() => { setRegister(!register); setMessage(''); setPassword(''); }}>{register ? 'Already have an account? Sign in' : 'Create an account'}</button>
      </form>
    </main>
  );
}

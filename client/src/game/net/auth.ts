// Getting an access token. This device keeps a long-lived session secret in
// localStorage (created as a guest on first visit, or handed back after
// signing in with Discord/Google), and trades it for a short-lived token
// whenever it (re)connects.
const KEY = 'eden.session';

export interface Me {
  token: string;
  empire: { id: number; name: string; color: number };
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Sign-in redirects land on /#session=... (the fragment never reaches a server log). */
function adoptRedirect() {
  const m = location.hash.match(/session=([\w-]+)/);
  if (!m) return;
  try {
    localStorage.setItem(KEY, m[1]);
  } catch {
    /* storage blocked: this visit stays signed in, the next starts over */
  }
  history.replaceState(null, '', location.pathname + location.search);
}

export function session() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let memory: string | null = null;

export async function signIn(): Promise<Me> {
  adoptRedirect();
  const s = session() ?? memory;
  if (s) {
    const r = await post('/auth/token', { session: s });
    if (r.ok) return r.json();
    if (r.status !== 401) throw new Error(`Sign-in failed (${r.status})`);
    try {
      localStorage.removeItem(KEY); // the session was revoked or the account deleted
    } catch {
      /* ignore */
    }
  }
  const r = await post('/auth/guest');
  if (!r.ok) throw new Error(r.status === 429 ? 'Too many new accounts from this network, try later' : `Sign-in failed (${r.status})`);
  const j = await r.json();
  memory = j.session;
  try {
    localStorage.setItem(KEY, j.session);
  } catch {
    /* ignore */
  }
  return j;
}

/** Start a Discord/Google sign-in. With a session, the provider is linked to this (guest) account. */
export async function linkProvider(provider: string) {
  const r = await post(`/auth/oauth/${provider}`, { session: session() ?? memory ?? undefined });
  if (!r.ok) throw new Error('That sign-in option is not available');
  location.href = (await r.json()).url;
}

export async function providers(): Promise<string[]> {
  const r = await fetch('/auth/providers');
  return r.ok ? (await r.json()).providers : [];
}

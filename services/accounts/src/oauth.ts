// "Sign in with Discord / Google": the OAuth 2.0 authorization-code flow.
//
//   browser ──► /auth/oauth/discord/start ──► 302 to Discord (with a random `state`)
//   Discord ──► /auth/oauth/discord/callback?code&state
//            we check `state` matches the cookie (stops forged logins), swap the
//            code for an access token server-to-server, ask who the user is,
//            keep only their stable id, and throw the token away.
//
// A provider is enabled by setting its client id and secret in the environment.
export interface Provider {
  id: 'discord' | 'google';
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  /** The provider's stable user id in its user-info response. */
  subject: (user: Record<string, unknown>) => string;
}

export function providers(): Map<string, Provider> {
  const out = new Map<string, Provider>();
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET)
    out.set('discord', {
      id: 'discord',
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      userUrl: 'https://discord.com/api/users/@me',
      scope: 'identify',
      clientId: DISCORD_CLIENT_ID,
      clientSecret: DISCORD_CLIENT_SECRET,
      subject: (u) => String(u.id),
    });
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
    out.set('google', {
      id: 'google',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid',
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      subject: (u) => String(u.sub),
    });
  return out;
}

export function authorizeUrl(p: Provider, redirectUri: string, state: string) {
  const u = new URL(p.authorizeUrl);
  u.search = new URLSearchParams({ client_id: p.clientId, redirect_uri: redirectUri, response_type: 'code', scope: p.scope, state, prompt: 'consent' }).toString();
  return u.toString();
}

/** Swap the one-time code for the provider's user id. */
export async function exchange(p: Provider, code: string, redirectUri: string): Promise<string> {
  const tok = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: p.clientId, client_secret: p.clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tok.ok) throw new Error(`${p.id} token exchange failed: ${tok.status}`);
  const { access_token } = (await tok.json()) as { access_token?: string };
  if (!access_token) throw new Error(`${p.id} returned no access token`);
  const me = await fetch(p.userUrl, { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!me.ok) throw new Error(`${p.id} user lookup failed: ${me.status}`);
  const subject = p.subject((await me.json()) as Record<string, unknown>);
  if (!subject || subject === 'undefined') throw new Error(`${p.id} returned no user id`);
  return subject;
}

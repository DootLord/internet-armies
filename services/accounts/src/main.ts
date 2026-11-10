// Accounts service: who players are. Stateless (all state is in Postgres), so it
// scales by running more replicas behind the load balancer.
//
//   POST   /auth/guest                 new account + empire + session; play immediately
//   POST   /auth/token                 session secret -> short-lived access token (JWT)
//   POST   /auth/logout                forget this device's session
//   GET    /auth/providers             which sign-in providers are configured
//   POST   /auth/oauth/:provider       begin sign-in (or linking, with a session) -> provider URL
//   GET    /auth/oauth/:provider/callback
//   GET    /auth/me                    your account (Bearer token)
//   PATCH  /auth/me                    rename your empire
//   DELETE /auth/me                    erase your account and empire (GDPR)
//   GET    /.well-known/jwks.json      public keys the gateway verifies tokens with
import { createHash, randomBytes } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { z } from 'zod';
import { bus, subj, TokenClaims } from '@eden/kit/bus';
import { Client, migrate, pool, tx } from '@eden/kit/db';
import { env, envInt } from '@eden/kit/env';
import { handleProbe, onShutdown } from '@eden/kit/lifecycle';
import { logger } from '@eden/kit/log';
import { encode, decode } from '@eden/shared/codec';
import { FACTIONS } from '@eden/shared/defs';
import { MIGRATIONS } from './migrations';
import { authorizeUrl, exchange, providers } from './oauth';
import { loadKeys, signState, signToken, STATE_AUDIENCE } from './tokens';

const log = logger('accounts');
const PUBLIC_URL = env('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, '');
const TOKEN_TTL = envInt('TOKEN_TTL_SECONDS', 3600);
const db = pool(env('DATABASE_URL'), 'accounts');
await migrate(db, 'accounts', MIGRATIONS, log);
const nc = await bus(env('NATS_URL', 'nats://localhost:4222'), 'accounts', log);
const keys = await loadKeys(db);
const verifyOwn = createLocalJWKSet(keys.jwks);
const PROVIDERS = providers();
log.info({ providers: [...PROVIDERS.keys()] }, 'sign-in providers');

const hash = (secret: string) => createHash('sha256').update(secret).digest();
const newSecret = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------- domain
const ADJ = ['Vega', 'Ashen', 'Crimson', 'Silent', 'Iron', 'Azure', 'Solar', 'Umbral', 'Verdant', 'Obsidian', 'Radiant', 'Hollow', 'Gilded', 'Tidal', 'Feral', 'Stellar'];
const NOUN = ['Syndicate', 'Accord', 'Dominion', 'Collective', 'Compact', 'Union', 'Covenant', 'Reach', 'Concord', 'Directorate', 'Combine', 'Assembly'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function createAccount(c: Client) {
  const acc = (await c.query('INSERT INTO accounts DEFAULT VALUES RETURNING id')).rows[0].id as string;
  await c.query('INSERT INTO empires (account_id, name, color) VALUES ($1, $2, $3)', [acc, `${pick(ADJ)} ${pick(NOUN)}`, Math.floor(Math.random() * FACTIONS.length)]);
  return acc;
}

async function createSession(c: Client, account: string) {
  const secret = newSecret();
  await c.query('INSERT INTO sessions (account_id, secret_hash) VALUES ($1, $2)', [account, hash(secret)]);
  return secret;
}

async function tokenFor(account: string) {
  const e = (await db.query('SELECT id, name, color FROM empires WHERE account_id = $1', [account])).rows[0];
  const claims: TokenClaims = { sub: account, emp: e.id, name: e.name, color: e.color };
  return { token: await signToken(keys, claims, TOKEN_TTL), empire: { id: e.id, name: e.name, color: e.color }, expiresIn: TOKEN_TTL };
}

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind one reverse proxy: take the client IP from X-Forwarded-For
app.use(express.json({ limit: '10kb' }));

const ready = async () => !nc.isClosed() && (await db.query('SELECT 1').then(() => true, () => false));
app.get(['/healthz', '/readyz'], (req, res) => void handleProbe(req, res, ready));

const guestLimit = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const authLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

type Authed = Request & { account?: string };
async function bearer(req: Authed, res: Response, next: NextFunction) {
  const m = req.headers.authorization?.match(/^Bearer (.+)$/);
  if (!m) return void res.status(401).json({ error: 'Sign in first' });
  try {
    const { payload } = await jwtVerify(m[1], verifyOwn, { issuer: 'eden-accounts', audience: 'eden' });
    req.account = payload.sub!;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

app.get('/.well-known/jwks.json', (_req, res) => {
  res.set('cache-control', 'public, max-age=300').json(keys.jwks);
});

app.post('/auth/guest', guestLimit, async (_req, res) => {
  const { account, session } = await tx(db, async (c) => {
    const account = await createAccount(c);
    return { account, session: await createSession(c, account) };
  });
  log.info({ account }, 'guest account created');
  res.status(201).json({ session, ...(await tokenFor(account)) });
});

const sessionBody = z.object({ session: z.string().min(20).max(100) });

app.post('/auth/token', authLimit, async (req, res) => {
  const b = sessionBody.safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: 'Bad request' });
  const row = (
    await db.query(
      `UPDATE sessions SET last_used_at = now() WHERE secret_hash = $1 RETURNING account_id`,
      [hash(b.data.session)],
    )
  ).rows[0];
  if (!row) return void res.status(401).json({ error: 'Unknown session' });
  await db.query('UPDATE accounts SET last_seen_at = now() WHERE id = $1', [row.account_id]);
  res.json(await tokenFor(row.account_id));
});

app.post('/auth/logout', authLimit, async (req, res) => {
  const b = sessionBody.safeParse(req.body);
  if (b.success) await db.query('DELETE FROM sessions WHERE secret_hash = $1', [hash(b.data.session)]);
  res.status(204).end();
});

app.get('/auth/providers', (_req, res) => {
  res.json({ providers: [...PROVIDERS.keys()] });
});

// ---- OAuth. `state` is a token we sign ourselves (who's linking, which provider, a nonce),
// and the nonce also goes in an HttpOnly cookie: the callback must present both, which
// proves the same browser that started the flow is finishing it.
const OAUTH_COOKIE = 'eden_oauth';
const redirectUri = (p: string) => `${PUBLIC_URL}/auth/oauth/${p}/callback`;

app.post('/auth/oauth/:provider', authLimit, async (req, res) => {
  const p = PROVIDERS.get(String(req.params.provider));
  if (!p) return void res.status(404).json({ error: 'Provider not configured' });
  let link: string | null = null;
  const b = sessionBody.safeParse(req.body);
  if (b.success) link = (await db.query('SELECT account_id FROM sessions WHERE secret_hash = $1', [hash(b.data.session)])).rows[0]?.account_id ?? null;
  const nonce = newSecret();
  const state = await signState(keys, link, nonce);
  res.cookie(OAUTH_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: PUBLIC_URL.startsWith('https'), path: '/auth/oauth', maxAge: 600_000 });
  res.json({ url: authorizeUrl(p, redirectUri(p.id), state) });
});

app.get('/auth/oauth/:provider/callback', authLimit, async (req, res) => {
  const fail = (why: string) => res.redirect(`${PUBLIC_URL}/#auth_error=${encodeURIComponent(why)}`);
  const p = PROVIDERS.get(String(req.params.provider));
  const code = String(req.query.code ?? ''), state = String(req.query.state ?? '');
  const nonce = req.headers.cookie?.match(new RegExp(`${OAUTH_COOKIE}=([^;]+)`))?.[1];
  res.clearCookie(OAUTH_COOKIE, { path: '/auth/oauth' });
  if (!p || !code || !state || !nonce) return void fail('Sign-in was cancelled');
  let link: string | null;
  try {
    const { payload } = await jwtVerify(state, verifyOwn, { issuer: 'eden-accounts', audience: STATE_AUDIENCE });
    if (payload.nonce !== nonce) return void fail('Sign-in expired, try again');
    link = typeof payload.link === 'string' ? payload.link : null;
  } catch {
    return void fail('Sign-in expired, try again');
  }
  let subject: string;
  try {
    subject = await exchange(p, code, redirectUri(p.id));
  } catch (e) {
    log.warn({ err: e, provider: p.id }, 'oauth exchange failed');
    return void fail(`${p.id} sign-in failed`);
  }
  const session = await tx(db, async (c) => {
    const known = (await c.query('SELECT account_id FROM identities WHERE provider = $1 AND subject = $2', [p.id, subject])).rows[0];
    let account: string;
    if (known) account = known.account_id; // already linked: sign in to that account (a guest linking it just switches over)
    else {
      account = link ?? (await createAccount(c));
      await c.query('INSERT INTO identities (provider, subject, account_id) VALUES ($1, $2, $3)', [p.id, subject, account]);
    }
    return createSession(c, account);
  });
  // The secret rides in the fragment, which browsers never send to servers or put in logs.
  res.redirect(`${PUBLIC_URL}/#session=${session}`);
});

app.get('/auth/me', bearer, async (req: Authed, res) => {
  const e = (await db.query('SELECT id, name, color FROM empires WHERE account_id = $1', [req.account])).rows[0];
  if (!e) return void res.status(404).json({ error: 'No such account' });
  const ids = (await db.query('SELECT provider FROM identities WHERE account_id = $1', [req.account])).rows.map((r) => r.provider);
  res.json({ empire: e, linked: ids, guest: ids.length === 0 });
});

const rename = z.object({ name: z.string().trim().min(3).max(24).regex(/^[\p{L}\p{N} '\-]+$/u) });
app.patch('/auth/me', bearer, async (req: Authed, res) => {
  const b = rename.safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: 'Names are 3-24 letters, digits, spaces, apostrophes or hyphens' });
  await db.query('UPDATE empires SET name = $2 WHERE account_id = $1', [req.account, b.data.name]);
  res.json(await tokenFor(req.account!)); // a fresh token carries the new name to the shard on next connect
});

app.delete('/auth/me', bearer, async (req: Authed, res) => {
  await tx(db, async (c) => {
    const e = (await c.query('SELECT id FROM empires WHERE account_id = $1', [req.account])).rows[0];
    // The outbox row commits with the deletion: either both happen or neither does.
    if (e) await c.query('INSERT INTO outbox (subject, payload) VALUES ($1, $2)', [subj.accountDeleted, { empire: e.id }]);
    await c.query('DELETE FROM accounts WHERE id = $1', [req.account]);
  });
  log.info({ account: req.account }, 'account deleted');
  res.status(204).end();
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, 'request failed');
  res.status(500).json({ error: 'Something went wrong' });
});

// ---------------------------------------------------------------- outbox relay
/**
 * Deliver outbox events until a shard acknowledges each one (at-least-once: a
 * shard may see a repeat, so handlers must be idempotent; purging twice is
 * harmless). SKIP LOCKED lets several replicas relay without double work.
 */
async function relay() {
  await tx(db, async (c) => {
    const rows = (await c.query('SELECT id, subject, payload FROM outbox ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED')).rows;
    for (const r of rows) {
      try {
        const reply = decode<{ ok?: boolean }>((await nc.request(r.subject, encode(r.payload), { timeout: 5000 })).data);
        if (!reply?.ok) throw new Error('not acknowledged');
        await c.query('DELETE FROM outbox WHERE id = $1', [r.id]);
      } catch (e) {
        await c.query('UPDATE outbox SET attempts = attempts + 1 WHERE id = $1', [r.id]);
        log.warn({ err: e, id: r.id, subject: r.subject }, 'outbox delivery failed; will retry');
      }
    }
  });
}
const relayTimer = setInterval(() => void relay().catch((e) => log.error({ err: e }, 'outbox relay failed')), 3000);

// ---------------------------------------------------------------- serve
const port = envInt('PORT', 3001);
const server = app.listen(port, () => log.info({ port }, 'accounts ready'));

onShutdown(log, [
  () => clearInterval(relayTimer),
  () => new Promise((r) => server.close(r)),
  () => nc.drain(),
  () => db.end(),
]);

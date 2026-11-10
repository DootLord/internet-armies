import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL;
let pool, app;
const origin = 'http://localhost:5173';
const email = `test-${randomUUID()}@example.test`;
const password = 'correct horse battery staple';
const ipSuffix = randomBytes(2);
const ip = `198.18.${ipSuffix[0]}.${ipSuffix[1]}`;
const limitIp = `198.19.${ipSuffix[0]}.${ipSuffix[1]}`;

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url });
  const { rows } = await pool.query('SELECT current_database() AS name');
  if (!rows[0].name.endsWith('_test')) {
    await pool.end();
    pool = undefined;
    throw new Error('Tests require a database whose name ends in _test');
  }
  app = await createApp({ pool, sessionSecret: 'test-secret-with-at-least-32-bytes', clientOrigin: origin, secureCookies: false, trustProxy: true });
});
after(async () => {
  if (!pool) return;
  try {
    const account = (await pool.query('SELECT id FROM accounts WHERE email = $1', [email])).rows[0];
    if (account) {
      await pool.query('DELETE FROM tiles WHERE owner_id IN (SELECT id FROM empires WHERE account_id = $1)', [account.id]);
      await pool.query('DELETE FROM empires WHERE account_id = $1', [account.id]);
      await pool.query("DELETE FROM user_sessions WHERE sess::jsonb #>> '{passport,user}' = $1", [account.id]);
      await pool.query('DELETE FROM accounts WHERE id = $1', [account.id]);
    }
    const buckets = [`register:${ip}`, `login:${ip}`, `login:${limitIp}`]
      .map((value) => createHash('sha256').update(`/${value}`).digest('hex'));
    await pool.query('DELETE FROM auth_attempts WHERE bucket = ANY($1::text[])', [buckets]);
  } finally {
    await pool.end();
  }
});

test('registration, authentication, sessions, origin checks, and rate limiting', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const agent = request.agent(app);
  const post = (path) => agent.post(path).set('Origin', origin).set('X-Forwarded-For', ip);

  assert.equal((await agent.get('/api/session')).body.user, null);
  assert.equal((await agent.post('/api/register').send({ email, password })).status, 403);
  assert.equal((await post('/api/register').send({ email, password: 'short' })).status, 400);
  assert.equal((await post('/api/register').send({ email: ` ${email.toUpperCase()} `, password })).status, 201);
  assert.equal((await post('/api/register').send({ email, password })).status, 409);

  const account = (await pool.query('SELECT id, password_hash FROM accounts WHERE email = $1', [email])).rows[0];
  assert.notEqual(account.password_hash, password);
  assert.ok(account.password_hash.startsWith('$2'));
  assert.equal((await post('/api/login').send({ email, password: 'incorrect' })).status, 401);
  assert.equal((await post('/api/login').send({ email: 'unknown@example.test', password })).status, 401);
  const login = await post('/api/login').send({ email, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, email);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Lax/);
  assert.equal((await agent.get('/api/session')).body.user.email, email);
  const secondApp = await createApp({ pool, sessionSecret: 'test-secret-with-at-least-32-bytes', clientOrigin: origin, secureCookies: false });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(secondApp).get('/api/session').set('Cookie', cookie)).body.user.email, email);
  assert.equal((await agent.post('/api/logout').set('Origin', 'https://evil.example')).status, 403);
  assert.equal((await post('/api/logout').send()).status, 204);
  assert.equal((await agent.get('/api/session')).body.user, null);
  assert.equal((await request(secondApp).get('/api/session').set('Cookie', cookie)).body.user, null);

  for (let i = 0; i < 10; i++) {
    assert.equal((await agent.post('/api/login').set('Origin', origin).set('X-Forwarded-For', limitIp).send({ email, password: 'wrong' })).status, 401);
  }
  assert.equal((await agent.post('/api/login').set('Origin', origin).set('X-Forwarded-For', limitIp).send({ email, password })).status, 429);
});

test('seed data and ownership constraints', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const sector = (await pool.query("SELECT * FROM sectors WHERE name = 'Kestrel Cluster'")).rows[0];
  assert.equal(sector.terrain_seed, 20261029);
  assert.equal(sector.radius_px, 14000);
  const starter = (await pool.query("SELECT * FROM starter_templates WHERE name = 'default'")).rows[0];
  assert.deepEqual([starter.credits, starter.alloy, starter.energy, starter.crystal], ['900', '450', '60', '40']);
  const account = (await pool.query('SELECT id FROM accounts WHERE email = $1', [email])).rows[0];
  const empire = (await pool.query("INSERT INTO empires (account_id, name, tag, color) VALUES ($1, 'Test', 'TST', '#49e0ff') RETURNING id", [account.id])).rows[0];
  const col = empire.id;
  await pool.query('INSERT INTO tiles (sector_id, col, row, owner_id) VALUES ($1, $2, 0, $3)', [sector.id, col, empire.id]);
  await assert.rejects(pool.query('INSERT INTO tiles (sector_id, col, row, owner_id) VALUES ($1, $2, 0, $3)', [sector.id, col, empire.id]), { code: '23505' });
  await assert.rejects(pool.query('INSERT INTO tiles (sector_id, col, row, owner_id) VALUES ($1, 1, 0, -1)', [sector.id]), { code: '23503' });
  await assert.rejects(pool.query('INSERT INTO empire_wallets (empire_id, credits) VALUES ($1, -1)', [empire.id]), { code: '23514' });
});

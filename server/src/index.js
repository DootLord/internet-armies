import pg from 'pg';
import { createApp } from './app.js';

const { DATABASE_URL, SESSION_SECRET, CLIENT_ORIGIN, NODE_ENV, PORT = '3000', TRUST_PROXY } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (NODE_ENV === 'production' && !CLIENT_ORIGIN?.startsWith('https://')) {
  throw new Error('CLIENT_ORIGIN must use HTTPS in production');
}
const pool = new pg.Pool({ connectionString: DATABASE_URL });
await pool.query('SELECT 1');
const app = await createApp({
  pool,
  sessionSecret: SESSION_SECRET,
  clientOrigin: CLIENT_ORIGIN,
  secureCookies: NODE_ENV === 'production',
  trustProxy: TRUST_PROXY === '1',
});
const server = app.listen(Number(PORT), () => console.log(`API listening on port ${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
}

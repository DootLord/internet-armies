import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcryptjs';

const PgSession = connectPgSimple(session);
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : '';
const validEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validPassword = (password) => typeof password === 'string'
  && password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 72;

export async function createApp({ pool, sessionSecret, clientOrigin, secureCookies = true, trustProxy = false }) {
  if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) throw new Error('SESSION_SECRET must be at least 32 bytes');
  if (!clientOrigin || new URL(clientOrigin).origin !== clientOrigin) throw new Error('CLIENT_ORIGIN must be an origin');
  const dummyHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const auth = new passport.Passport();
  auth.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const { rows } = await pool.query('SELECT id, email, password_hash FROM accounts WHERE email = $1', [normalizeEmail(email)]);
      const account = rows[0];
      const matches = await bcrypt.compare(password, account?.password_hash ?? dummyHash);
      return done(null, account && matches ? { id: account.id, email: account.email } : false);
    } catch (error) {
      return done(error);
    }
  }));
  auth.serializeUser((user, done) => done(null, user.id));
  auth.deserializeUser(async (id, done) => {
    try {
      const { rows } = await pool.query('SELECT id, email FROM accounts WHERE id = $1', [id]);
      done(null, rows[0] || false);
    } catch (error) {
      done(error);
    }
  });

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '4kb' }));
  app.use(session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: 900 }),
    name: 'ia.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: secureCookies, sameSite: 'lax', maxAge: MAX_AGE },
  }));
  app.use(auth.initialize());
  app.use(auth.session());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.get('origin') !== clientOrigin) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
    next();
  });

  const limitAuth = async (req, res, next) => {
    try {
      // Separate buckets by endpoint and IP; the database makes limits shared across replicas.
      const bucket = crypto.createHash('sha256').update(`${req.path}:${req.ip}`).digest('hex');
      const { rows } = await pool.query(`
        INSERT INTO auth_attempts (bucket, count, expires_at) VALUES ($1, 1, now() + interval '15 minutes')
        ON CONFLICT (bucket) DO UPDATE SET
          count = CASE WHEN auth_attempts.expires_at <= now() THEN 1 ELSE auth_attempts.count + 1 END,
          expires_at = CASE WHEN auth_attempts.expires_at <= now() THEN now() + interval '15 minutes' ELSE auth_attempts.expires_at END
        RETURNING count`, [bucket]);
      if (rows[0].count > 10) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      next();
    } catch (error) {
      next(error);
    }
  };

  app.get('/api/session', (req, res) => res.json({ user: req.user ?? null }));
  app.post('/api/register', limitAuth, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      if (!validEmail(email) || !validPassword(password)) {
        return res.status(400).json({ error: 'Enter a valid email and a password of at least 12 characters and at most 72 UTF-8 bytes.' });
      }
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await pool.query(
        'INSERT INTO accounts (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
        [email, hash],
      );
      if (!rows.length) return res.status(409).json({ error: 'Unable to create account with this email.' });
      res.status(201).json({ message: 'Account created. You can now sign in.' });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/login', limitAuth, (req, res, next) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!validEmail(email) || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    req.body.email = email;
    auth.authenticate('local', (error, user) => {
      if (error) return next(error);
      if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
      req.login(user, (loginError) => {
        if (loginError) return next(loginError);
        res.json({ user });
      });
    })(req, res, next);
  });
  app.post('/api/logout', (req, res, next) => {
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy((destroyError) => {
        if (destroyError) return next(destroyError);
        res.clearCookie('ia.sid', { httpOnly: true, secure: secureCookies, sameSite: 'lax' });
        res.status(204).end();
      });
    });
  });
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(error.status).json({ error: 'Invalid request body.' });
    }
    console.error('Request failed:', error);
    res.status(500).json({ error: 'Internal server error.' });
  });
  return app;
}

// Access tokens: short-lived signed JWTs (EdDSA) that say "this socket is empire
// N". The accounts service signs them; the gateway verifies them using only the
// public key (fetched from /.well-known/jwks.json), so the gateway never needs
// a secret and never has to call us per connection.
import { exportJWK, generateKeyPair, importJWK, JWK, SignJWT } from 'jose';
import type { TokenClaims } from '@eden/kit/bus';
import type { Pool } from '@eden/kit/db';

const ALG = 'EdDSA';

export interface Keys {
  kid: string;
  private: CryptoKey;
  jwks: { keys: JWK[] };
}

/**
 * Load the newest signing key, creating one on first boot. Replicas race to
 * insert; ON CONFLICT plus a re-read means they all end up with the same key.
 */
export async function loadKeys(db: Pool): Promise<Keys> {
  let rows = (await db.query('SELECT kid, private_jwk, public_jwk FROM signing_keys ORDER BY created_at DESC')).rows;
  if (!rows.length) {
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    const kid = new Date().toISOString().slice(0, 10) + '-' + crypto.randomUUID().slice(0, 8);
    const pub = { ...(await exportJWK(publicKey)), kid, alg: ALG, use: 'sig' };
    const priv = { ...(await exportJWK(privateKey)), kid, alg: ALG };
    await db.query('INSERT INTO signing_keys (kid, private_jwk, public_jwk) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [kid, priv, pub]);
    rows = (await db.query('SELECT kid, private_jwk, public_jwk FROM signing_keys ORDER BY created_at DESC')).rows;
  }
  const newest = rows[0];
  return {
    kid: newest.kid,
    private: (await importJWK(newest.private_jwk, ALG)) as CryptoKey,
    // Publish every key we still hold, so tokens signed just before a rotation keep verifying.
    jwks: { keys: rows.map((r) => r.public_jwk) },
  };
}

/**
 * The OAuth `state` value. A different audience from access tokens matters:
 * otherwise a state could be replayed to the gateway as a login.
 */
export const STATE_AUDIENCE = 'eden-oauth-state';
export function signState(keys: Keys, link: string | null, nonce: string) {
  return new SignJWT({ link, nonce })
    .setProtectedHeader({ alg: ALG, kid: keys.kid })
    .setIssuer('eden-accounts')
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('600s')
    .sign(keys.private);
}

export function signToken(keys: Keys, claims: TokenClaims, ttlSeconds: number) {
  const { sub, ...rest } = claims;
  return new SignJWT({ ...rest })
    .setProtectedHeader({ alg: ALG, kid: keys.kid })
    .setSubject(sub)
    .setIssuer('eden-accounts')
    .setAudience('eden')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(keys.private);
}

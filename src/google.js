// Connexion Google / Apple côté serveur — miroir de l'action
// `googlesignin` de l'appli web et de la connexion native (paquet
// `google_sign_in` / « Se connecter avec Apple » sur iOS).
// L'identifiant et le secret viennent des réglages admin (table
// `settings`) ou, à défaut, des variables d'environnement
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APPLE_CLIENT_ID).
// AUCUN identifiant ni secret n'est créé ici.
import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { get, run } from './db.js';
import { fetchJson } from './http.js';
import { publicCustomer, signToken } from './auth.js';
import { getSetting, googleSettingsFromStore } from './admin.js';

async function findOrCreateGoogleCustomer({ email, name }) {
  let customer = await get('SELECT * FROM customers WHERE google_email = $1', email);
  if (customer) return customer;
  const created_at = new Date().toISOString();
  const result = await run(
    `INSERT INTO customers (name, phone, password_hash, google_email, auth_provider, created_at)
     VALUES ($1, NULL, NULL, $2, 'google', $3) RETURNING *`,
    name || email.split('@')[0], email, created_at,
  );
  return result.rows[0];
}

async function findOrCreateAppleCustomer({ sub, email, name }) {
  let customer = await get('SELECT * FROM customers WHERE apple_sub = $1', sub);
  if (customer) return customer;
  if (email) {
    customer = await get('SELECT * FROM customers WHERE google_email = $1', email);
    if (customer) {
      await run('UPDATE customers SET apple_sub = $1 WHERE id = $2', sub, customer.id);
      return await get('SELECT * FROM customers WHERE id = $1', customer.id);
    }
  }
  const created_at = new Date().toISOString();
  const displayName = name || (email ? email.split('@')[0] : 'Client Apple');
  const result = await run(
    `INSERT INTO customers (name, phone, password_hash, google_email, apple_sub, auth_provider, created_at)
     VALUES ($1, NULL, NULL, $2, $3, 'apple', $4) RETURNING *`,
    displayName, email || null, sub, created_at,
  );
  return result.rows[0];
}

export const googleRouter = Router();

// GET /api/config/google — identifiant client public + connexion activée.
googleRouter.get('/config/google', async (req, res) => {
  const stored = await getSetting('google');
  const s = googleSettingsFromStore(stored);
  return res.json({
    ok: true,
    enabled: s.enabled && Boolean(s.client_id),
    client_id: s.client_id || null,
  });
});

// POST /api/auth/google — échange du code côté serveur.
// Corps : { code, redirect_uri? } (redirect_uri = 'postmessage' par défaut,
// comme pour la fenêtre Google Identity Services de l'appli web).
googleRouter.post('/auth/google', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const redirect_uri = String(req.body?.redirect_uri || 'postmessage');
  if (!code) return res.status(400).json({ ok: false, error: 'code_required' });

  const stored = await getSetting('google');
  const s = googleSettingsFromStore(stored);
  if (!s.client_id || !s.client_secret) {
    return res.status(400).json({ ok: false, error: 'google_not_configured' });
  }
  if (!s.enabled) {
    return res.status(400).json({ ok: false, error: 'google_disabled' });
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: s.client_id,
      client_secret: s.client_secret,
      redirect_uri,
    });
    const { ok: tokenOk, data: tokenData } = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!tokenOk || !tokenData?.id_token) {
      const errCode = tokenData?.error || 'google_error';
      if (errCode === 'invalid_client') {
        return res.status(502).json({ ok: false, error: 'invalid_client', message: tokenData?.error_description || '' });
      }
      return res.status(502).json({ ok: false, error: 'google_auth_failed', message: tokenData?.error_description || errCode });
    }

    // Vérification du jeton d'identité chez Google.
    const { ok: infoOk, data: info } = await fetchJson(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`,
    );
    if (!infoOk || !info?.email) {
      return res.status(502).json({ ok: false, error: 'google_token_invalid' });
    }
    if (info.aud !== s.client_id) {
      return res.status(502).json({ ok: false, error: 'google_audience_mismatch' });
    }
    if (info.email_verified !== 'true') {
      return res.status(403).json({ ok: false, error: 'email_not_verified' });
    }

    const customer = await findOrCreateGoogleCustomer({
      email: info.email,
      name: info.name || [info.given_name, info.family_name].filter(Boolean).join(' '),
    });
    return res.json({
      ok: true,
      token: signToken(customer),
      customer: publicCustomer(customer),
      provider: 'google',
    });
  } catch (err) {
    console.error('[auth/google]', err.message);
    return res.status(502).json({ ok: false, error: 'google_unreachable', message: err.message });
  }
});

// POST /api/auth/apple — vérification du jeton d'identité Apple (iOS).
// Corps : { identity_token, name? }. Le jeton est vérifié par la clé
// publique Apple (JWKS) : émetteur, audience (identifiant du paquet iOS)
// et expiration. Aucun secret Apple n'est nécessaire ici.
googleRouter.post('/auth/apple', async (req, res) => {
  const identity_token = String(req.body?.identity_token || '').trim();
  if (!identity_token) {
    return res.status(400).json({ ok: false, error: 'token_required' });
  }
  const clientId = process.env.APPLE_CLIENT_ID || '';
  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'apple_not_configured' });
  }
  try {
    const decoded = jwt.decode(identity_token, { complete: true });
    if (!decoded?.header?.kid) {
      return res.status(401).json({ ok: false, error: 'token_invalid' });
    }
    const { data: jwks } = await fetchJson('https://appleid.apple.com/auth/keys');
    const jwk = jwks?.keys?.find((k) => k.kid === decoded.header.kid);
    if (!jwk) {
      return res.status(401).json({ ok: false, error: 'token_invalid' });
    }
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const payload = jwt.verify(identity_token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: clientId,
    });
    const customer = await findOrCreateAppleCustomer({
      sub: payload.sub,
      email: payload.email || null,
      name: String(req.body?.name || '').trim() || null,
    });
    return res.json({
      ok: true,
      token: signToken(customer),
      customer: publicCustomer(customer),
      provider: 'apple',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ ok: false, error: 'token_invalid' });
    }
    console.error('[auth/apple]', err.message);
    return res.status(502).json({ ok: false, error: 'apple_unreachable', message: err.message });
  }
});

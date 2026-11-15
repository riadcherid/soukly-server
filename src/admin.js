// Routes admin — miroir des actions `upsertproduct`, `deleteproduct`,
// `upsertcategory`, `saveinventory`, `getaisettings`, `saveaisettings`,
// `describeproductphoto`, `testaikey`, `getgooglesettings`,
// `savegooglesettings`, `testgooglesettings` de l'appli web.
// L'appli web n'a pas d'authentification admin : ici, un jeton simple
// en variable d'environnement (ADMIN_TOKEN) est exigé sur /api/admin/*.
// Les secrets (clé IA, secret Google) sont stockés dans la table
// `settings` et ne sont JAMAIS renvoyés en clair (masqués).
import { Router } from 'express';
import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { fetchJson } from './http.js';
import { photoUrl } from './photos.js';

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.warn('[admin] ADMIN_TOKEN non défini — les routes /api/admin/* sont fermées (503).');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'admin_not_configured' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'admin_auth_required' });
  }
  return next();
}

// --- Réglages (table `settings`, valeurs JSON) ---

export async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = $1', key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function setSetting(key, value) {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    key, JSON.stringify(value), now,
  );
}

// Masque un secret : « GOC…9tBj » (3 premiers + … + 4 derniers).
function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return null;
  if (s.length <= 7) return '****';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function toProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category_key,
    unit: row.unit,
    price_cents: row.price_cents,
    sold_by_weight: row.sold_by_weight === true,
    prepared: row.prepared === true,
    available: row.available === true,
    image_key: row.image_key,
    photo_url: photoUrl(row.image_key),
  };
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || 'rayon';
}

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// --- Produits ---

// POST /api/admin/products — ajouter / modifier un produit.
// Le prix est en cents par kg pour les produits au poids (la conversion
// $/lb → $/kg se fait côté appli admin, comme dans l'appli web).
adminRouter.post('/products', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const category_key = String(body.category_key || '').trim();
  const unit = String(body.unit || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!category_key) return res.status(400).json({ ok: false, error: 'category_required' });
  if (!unit) return res.status(400).json({ ok: false, error: 'unit_required' });
  const category = await get('SELECT key FROM categories WHERE key = $1', category_key);
  if (!category) return res.status(400).json({ ok: false, error: 'category_not_found' });

  const price_cents = Math.max(0, Math.floor(Number(body.price_cents) || 0));
  const sold_by_weight = body.sold_by_weight === true;
  const prepared = body.prepared === true;
  const available = body.available === true;
  const description = String(body.description || '').trim();
  const image_key = body.image_key != null ? String(body.image_key) : null;

  const id = body.id != null ? Number(body.id) : null;
  let product;
  if (id != null && Number.isInteger(id) && id > 0) {
    const existing = await get('SELECT id FROM products WHERE id = $1', id);
    if (existing) {
      const result = await run(
        `UPDATE products SET name = $1, description = $2, category_key = $3, unit = $4,
           price_cents = $5, sold_by_weight = $6, available = $7, image_key = $8,
           prepared = $9
         WHERE id = $10 RETURNING *`,
        name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared, id,
      );
      product = result.rows[0];
    } else {
      const result = await run(
        `INSERT INTO products
           (id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared,
      );
      product = result.rows[0];
    }
  } else {
    const next = await get('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM products');
    const result = await run(
      `INSERT INTO products
         (id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      next.id, name, description, category_key, unit, price_cents, sold_by_weight, available, image_key, prepared,
    );
    product = result.rows[0];
  }
  return res.status(201).json({ ok: true, product: toProduct(product) });
});

// DELETE /api/admin/products/{id} — retirer un produit.
adminRouter.delete('/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  const product = await get('SELECT id FROM products WHERE id = $1', id);
  if (!product) return res.status(404).json({ ok: false, error: 'product_not_found' });
  try {
    await run('DELETE FROM products WHERE id = $1', id);
  } catch (err) {
    // Produit référencé par une commande : refus (intégrité référentielle).
    if (err.code === '23503') {
      return res.status(409).json({ ok: false, error: 'product_in_use' });
    }
    throw err;
  }
  return res.json({ ok: true, deleted_id: id });
});

// --- Rayons ---

// POST /api/admin/categories — ajouter / renommer un rayon.
adminRouter.post('/categories', async (req, res) => {
  const body = req.body || {};
  const label = String(body.label || '').trim();
  if (!label) return res.status(400).json({ ok: false, error: 'label_required' });
  const key = String(body.key || '').trim() || slugify(label);
  const existing = await get('SELECT key FROM categories WHERE key = $1', key);
  let sort = Number(body.sort);
  if (!Number.isInteger(sort) || sort < 1) {
    const row = await get('SELECT COALESCE(MAX(sort), 0) + 1 AS sort FROM categories');
    sort = row.sort;
  }
  if (existing) {
    await run('UPDATE categories SET label = $1, sort = $2 WHERE key = $3', label, sort, key);
  } else {
    await run(
      'INSERT INTO categories (key, label, sort) VALUES ($1, $2, $3)',
      key, label, sort,
    );
  }
  const category = await get('SELECT key, label, sort FROM categories WHERE key = $1', key);
  return res.status(201).json({ ok: true, category });
});

// --- Inventaire du matin ---

// POST /api/admin/inventory — prix et dispos du jour.
// Corps : { date?, note?, prices: [{ product_id, price_cents, available? }] }
adminRouter.post('/inventory', async (req, res) => {
  const body = req.body || {};
  const prices = body.prices;
  if (!Array.isArray(prices)) {
    return res.status(400).json({ ok: false, error: 'prices_required' });
  }
  let updated = 0;
  for (const p of prices) {
    const product_id = Number(p?.product_id);
    const price_cents = Math.floor(Number(p?.price_cents));
    if (!Number.isInteger(product_id) || !Number.isInteger(price_cents) || price_cents < 0) {
      return res.status(400).json({ ok: false, error: 'price_invalid', product_id });
    }
    const product = await get('SELECT id FROM products WHERE id = $1', product_id);
    if (!product) {
      return res.status(400).json({ ok: false, error: 'product_not_found', product_id });
    }
    const available = p?.available === undefined ? price_cents > 0 : p.available === true;
    await run(
      'UPDATE products SET price_cents = $1, available = $2 WHERE id = $3',
      price_cents, available, product_id,
    );
    updated += 1;
  }
  const date = String(body.date || new Date().toISOString().slice(0, 10));
  const note = body.note != null ? String(body.note) : null;
  const now = new Date().toISOString();
  await run(
    `INSERT INTO inventory (id, date, note, updated_at) VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
    date, note, now,
  );
  return res.json({ ok: true, updated, date, note });
});

// --- Réglages IA ---

function aiSettingsFromStore(stored) {
  return {
    provider: stored?.provider || 'gemini',
    api_key: stored?.api_key || '',
  };
}

adminRouter.get('/ai-settings', async (req, res) => {
  const stored = await getSetting('ai');
  const s = aiSettingsFromStore(stored);
  return res.json({
    ok: true,
    provider: s.provider,
    api_key_masked: maskSecret(s.api_key),
    has_key: Boolean(s.api_key),
  });
});

adminRouter.post('/ai-settings', async (req, res) => {
  const body = req.body || {};
  const provider = String(body.provider || 'gemini');
  if (provider !== 'gemini' && provider !== 'openai') {
    return res.status(400).json({ ok: false, error: 'provider_invalid' });
  }
  const stored = await getSetting('ai');
  const current = aiSettingsFromStore(stored);
  const api_key = body.api_key != null ? String(body.api_key) : current.api_key;
  await setSetting('ai', { provider, api_key });
  return res.json({
    ok: true,
    provider,
    api_key_masked: maskSecret(api_key),
    has_key: Boolean(api_key),
  });
});

// --- Appels IA (Gemini / OpenAI) ---

const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash'];

async function geminiGenerate({ apiKey, model, parts }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const { status, ok, data } = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!ok) {
    const err = new Error(data?.error?.message || `gemini_${status}`);
    err.status = status;
    err.googleError = data?.error || null;
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text;
}

async function geminiGenerateWithFallback({ apiKey, parts }) {
  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const text = await geminiGenerate({ apiKey, model, parts });
      return { text, model };
    } catch (err) {
      lastError = err;
      // 404 (modèle retiré) ou 429/503 (quota) : essayer le suivant.
      if (err.status !== 404 && err.status !== 429 && err.status !== 503) throw err;
    }
  }
  throw lastError;
}

async function openaiChat({ apiKey, messages }) {
  const { status, ok, data } = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
  });
  if (!ok) {
    const err = new Error(data?.error?.message || `openai_${status}`);
    err.status = status;
    throw err;
  }
  return data?.choices?.[0]?.message?.content || '';
}

function parseAiProductJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// POST /api/admin/ai/describe-photo — description IA en français depuis une photo.
adminRouter.post('/ai/describe-photo', async (req, res) => {
  const body = req.body || {};
  const data_base64 = String(body.data_base64 || '');
  const mime_type = String(body.mime_type || 'image/jpeg');
  const name = String(body.name || '').trim();
  if (!data_base64) return res.status(400).json({ ok: false, error: 'photo_required' });

  const stored = await getSetting('ai');
  const s = aiSettingsFromStore(stored);
  if (!s.api_key) return res.status(400).json({ ok: false, error: 'no_key' });

  const categories = await all('SELECT key, label FROM categories ORDER BY sort');
  const categoryList = categories.map((c) => `${c.key} (${c.label})`).join(', ');
  const prompt =
    `Tu es l'assistant de l'épicerie Soukly. Décris ce produit en une phrase en français, ` +
    `donne son nom exact tel qu'il apparaît sur l'emballage si lisible, sinon un nom simple, ` +
    `et choisis son rayon parmi : ${categoryList}. ` +
    (name ? `Nom indiqué : ${name}. ` : '') +
    `Réponds uniquement en JSON : {"description": "...", "name": "...", "category": "<clé du rayon>"}.`;

  try {
    let text;
    if (s.provider === 'openai') {
      text = await openaiChat({
        apiKey: s.api_key,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime_type};base64,${data_base64}` } },
          ],
        }],
      });
    } else {
      const result = await geminiGenerateWithFallback({
        apiKey: s.api_key,
        parts: [
          { text: prompt },
          { inline_data: { mime_type, data: data_base64 } },
        ],
      });
      text = result.text;
    }
    const parsed = parseAiProductJson(text);
    if (!parsed || !parsed.description) {
      return res.json({
        ok: true,
        description: String(text || '').trim().slice(0, 300),
        suggested_name: name || null,
        suggested_category: null,
        raw: true,
      });
    }
    const categoryOk = categories.some((c) => c.key === parsed.category);
    return res.json({
      ok: true,
      description: String(parsed.description || '').trim(),
      suggested_name: String(parsed.name || name || '').trim() || null,
      suggested_category: categoryOk ? parsed.category : null,
    });
  } catch (err) {
    console.error('[ai/describe-photo]', err.message);
    return res.status(502).json({ ok: false, error: 'ai_error', message: err.message });
  }
});

// POST /api/admin/ai/test-key — tester la clé IA (petit appel texte).
adminRouter.post('/ai/test-key', async (req, res) => {
  const stored = await getSetting('ai');
  const s = aiSettingsFromStore(stored);
  if (!s.api_key) return res.status(400).json({ ok: false, error: 'no_key' });
  try {
    if (s.provider === 'openai') {
      const { ok, data } = await fetchJson('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${s.api_key}` },
      });
      if (!ok) {
        return res.json({ ok: false, valid: false, error: data?.error?.message || 'openai_error' });
      }
      return res.json({ ok: true, valid: true, provider: 'openai' });
    }
    const result = await geminiGenerateWithFallback({
      apiKey: s.api_key,
      parts: [{ text: 'Réponds uniquement : OK' }],
    });
    return res.json({ ok: true, valid: true, provider: 'gemini', model: result.model });
  } catch (err) {
    console.error('[ai/test-key]', err.message);
    return res.json({ ok: false, valid: false, error: err.message });
  }
});

// --- Réglages Google ---

export function googleSettingsFromStore(stored) {
  return {
    client_id: stored?.client_id || process.env.GOOGLE_CLIENT_ID || '',
    client_secret: stored?.client_secret || process.env.GOOGLE_CLIENT_SECRET || '',
    enabled: stored?.enabled !== false,
  };
}

adminRouter.get('/google-settings', async (req, res) => {
  const stored = await getSetting('google');
  const s = googleSettingsFromStore(stored);
  return res.json({
    ok: true,
    client_id: s.client_id,
    client_secret_masked: maskSecret(s.client_secret),
    has_secret: Boolean(s.client_secret),
    enabled: s.enabled,
  });
});

adminRouter.post('/google-settings', async (req, res) => {
  const body = req.body || {};
  const stored = await getSetting('google');
  const current = googleSettingsFromStore(stored);
  const client_id = body.client_id != null ? String(body.client_id) : current.client_id;
  const client_secret = body.client_secret != null ? String(body.client_secret) : current.client_secret;
  const enabled = body.enabled != null ? body.enabled === true : current.enabled;
  await setSetting('google', { client_id, client_secret, enabled });
  return res.json({
    ok: true,
    client_id,
    client_secret_masked: maskSecret(client_secret),
    has_secret: Boolean(client_secret),
    enabled,
  });
});

// POST /api/admin/google/test — rejouer un faux échange de code chez Google.
// Google répond « Malformed auth code » si le secret est accepté,
// « invalid_client » si le secret est invalide.
adminRouter.post('/google/test', async (req, res) => {
  const stored = await getSetting('google');
  const s = googleSettingsFromStore(stored);
  if (!s.client_id || !s.client_secret) {
    return res.status(400).json({ ok: false, error: 'google_not_configured' });
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'test-code',
      client_id: s.client_id,
      client_secret: s.client_secret,
      redirect_uri: 'postmessage',
    });
    const { status, data } = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const errCode = data?.error;
    if (errCode === 'invalid_client') {
      return res.json({ ok: false, valid: false, error: 'invalid_client', message: data?.error_description || '' });
    }
    if (errCode === 'invalid_grant') {
      // Le code est rejeté mais le secret est accepté : config valide.
      return res.json({ ok: true, valid: true, google_error: errCode, message: data?.error_description || '' });
    }
    return res.json({ ok: false, valid: false, error: errCode || `google_${status}`, message: data?.error_description || '' });
  } catch (err) {
    console.error('[google/test]', err.message);
    return res.status(502).json({ ok: false, error: 'google_unreachable', message: err.message });
  }
});

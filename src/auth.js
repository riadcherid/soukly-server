// Authentification client — comptes par nom + téléphone + mot de passe.
// Miroir des actions `registercustomer`, `logincustomer`, `getme` de
// l'appli web. Jeton de session JWT (Bearer), mot de passe haché bcrypt.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get, run } from './db.js';
import { isValidEmail, normalizeEmail } from './email.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET non défini — secret de développement utilisé.');
}
const JWT_EXPIRES_IN = '30d';

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function publicCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    // E-mail pour le reçu de commande : `email` si défini, sinon
    // `google_email` (compte Google / Apple).
    email: row.email || row.google_email || null,
  };
}

export { publicCustomer };

function signToken(customer) {
  return jwt.sign(
    { customer_id: customer.id, phone: customer.phone },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export { signToken };

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'auth_required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const customer = await get('SELECT * FROM customers WHERE id = $1', payload.customer_id);
    if (!customer) {
      return res.status(401).json({ ok: false, error: 'auth_invalid' });
    }
    req.customer = customer;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'auth_invalid' });
  }
}

export const authRouter = Router();

authRouter.post('/auth/register', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  // E-mail obligatoire à l'inscription (reçu de commande, comme Uber).
  const email = normalizeEmail(req.body?.email);

  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (phone.length < 10) return res.status(400).json({ ok: false, error: 'phone_invalid' });
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'email_invalid' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'password_too_short' });
  }

  const existing = await get('SELECT id FROM customers WHERE phone = $1', phone);
  if (existing) {
    return res.status(409).json({ ok: false, error: 'phone_already_registered' });
  }
  const existingEmail = await get('SELECT id FROM customers WHERE email = $1', email);
  if (existingEmail) {
    return res.status(409).json({ ok: false, error: 'email_already_registered' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const created_at = new Date().toISOString();
  const result = await run(
    `INSERT INTO customers (name, phone, email, password_hash, auth_provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    name, phone, email, password_hash, 'password', created_at,
  );
  const customer = result.rows[0];
  return res.status(201).json({
    ok: true,
    token: signToken(customer),
    customer: publicCustomer(customer),
  });
});

authRouter.post('/auth/login', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  const customer = await get('SELECT * FROM customers WHERE phone = $1', phone);
  if (!customer || !customer.password_hash) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  if (!bcrypt.compareSync(password, customer.password_hash)) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  return res.json({
    ok: true,
    token: signToken(customer),
    customer: publicCustomer(customer),
  });
});

authRouter.get('/auth/me', requireAuth, (req, res) => {
  return res.json({ ok: true, customer: publicCustomer(req.customer) });
});

// PATCH /api/auth/me — ajouter / modifier son e-mail (comptes existants
// sans e-mail, ex. le compte de Riad). Validé et unique.
authRouter.patch('/auth/me', requireAuth, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'email_invalid' });
  }
  const taken = await get(
    'SELECT id FROM customers WHERE email = $1 AND id <> $2',
    email, req.customer.id,
  );
  if (taken) {
    return res.status(409).json({ ok: false, error: 'email_already_registered' });
  }
  const result = await run(
    'UPDATE customers SET email = $1 WHERE id = $2 RETURNING *',
    email, req.customer.id,
  );
  return res.json({ ok: true, customer: publicCustomer(result.rows[0]) });
});

// POST /api/auth/logout — jeton JWT sans état : le client jette son jeton.
authRouter.post('/auth/logout', (req, res) => {
  return res.json({ ok: true });
});

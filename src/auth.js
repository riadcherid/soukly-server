// Authentification client — comptes par nom d'utilisateur + e-mail +
// téléphone + mot de passe (le nom complet est facultatif : l'affichage
// retombe sur le nom d'utilisateur). Connexion par téléphone, e-mail ou
// nom d'utilisateur + mot de passe.
// Miroir des actions `registercustomer`, `logincustomer`, `getme` de
// l'appli web. Jeton de session JWT (Bearer), mot de passe haché bcrypt.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get, run } from './db.js';
import { isValidEmail, normalizeEmail } from './email.js';
import { photoUrl, photoUpload, photoUploadError } from './photos.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET non défini — secret de développement utilisé.');
}
const JWT_EXPIRES_IN = '30d';

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/// Nom d'utilisateur : minuscules + espaces retirés, 3 à 30 caractères,
/// lettres / chiffres / . _ - . Insensible à la casse (stocké en
/// minuscules, cherché en minuscules).
function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

const USERNAME_REGEX = /^[a-z0-9._-]{3,30}$/;

function isValidUsername(username) {
  return USERNAME_REGEX.test(normalizeUsername(username));
}

function publicCustomer(row) {
  return {
    id: row.id,
    // Nom affiché : le nom complet s'il existe, sinon le nom
    // d'utilisateur (l'inscription ne demande plus le nom).
    name: row.name || row.username || '',
    username: row.username || null,
    phone: row.phone,
    // E-mail pour le reçu de commande : `email` si défini, sinon
    // `google_email` (compte Google / Apple).
    email: row.email || row.google_email || null,
    created_at: row.created_at || null,
    photo_url: photoUrl(row.photo_key),
    bio: row.bio || null,
    address: row.address || null,
    postal_code: row.postal_code || null,
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
  // Le nom complet est facultatif : le nom d'utilisateur suffit.
  const name = String(req.body?.name || '').trim() || null;
  const username = normalizeUsername(req.body?.username);
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  // E-mail obligatoire à l'inscription (reçu de commande, comme Uber).
  const email = normalizeEmail(req.body?.email);

  if (!isValidUsername(username)) {
    return res.status(400).json({ ok: false, error: 'username_invalid' });
  }
  if (phone.length < 10) return res.status(400).json({ ok: false, error: 'phone_invalid' });
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'email_invalid' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'password_too_short' });
  }

  const existingUsername = await get('SELECT id FROM customers WHERE username = $1', username);
  if (existingUsername) {
    return res.status(409).json({ ok: false, error: 'username_taken' });
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
    `INSERT INTO customers (name, username, phone, email, password_hash, auth_provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    name, username, phone, email, password_hash, 'password', created_at,
  );
  const customer = result.rows[0];
  return res.status(201).json({
    ok: true,
    token: signToken(customer),
    customer: publicCustomer(customer),
  });
});

authRouter.post('/auth/login', async (req, res) => {
  // Identifiant unique : nom d'utilisateur OU e-mail. Le téléphone
  // reste accepté côté serveur comme repli pour les comptes anciens
  // sans e-mail ni nom d'utilisateur (voir ci-dessous) ; `phone`
  // reste aussi accepté en entrée pour l'ancien client.
  const identifier = String(req.body?.identifier ?? req.body?.phone ?? '').trim();
  const password = String(req.body?.password || '');
  let customer = null;
  if (identifier.includes('@')) {
    // E-mail (normalisé : minuscules + trim).
    customer = await get(
      'SELECT * FROM customers WHERE email = $1',
      normalizeEmail(identifier),
    );
  } else if (normalizePhone(identifier).length >= 10) {
    // Téléphone — REPLI UNIQUEMENT pour les comptes anciens qui n'ont
    // ni e-mail ni nom d'utilisateur (ex. le compte de Riad : téléphone
    // + nom seulement). Un compte qui a un e-mail ou un nom
    // d'utilisateur ne se connecte plus par téléphone : il doit
    // utiliser son nom d'utilisateur ou son e-mail. Ce repli n'est
    // pas proposé dans l'appli ; il évite juste de bloquer dehors les
    // comptes créés avant le nom d'utilisateur.
    customer = await get(
      'SELECT * FROM customers WHERE phone = $1',
      normalizePhone(identifier),
    );
    if (customer && (customer.email || customer.username)) customer = null;
  } else {
    // Nom d'utilisateur (insensible à la casse).
    customer = await get(
      'SELECT * FROM customers WHERE username = $1',
      normalizeUsername(identifier),
    );
  }
  // Même erreur générique dans tous les cas : on ne révèle jamais si
  // c'est l'identifiant ou le mot de passe qui est faux.
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

// PATCH /api/auth/me — modifier son profil : e-mail et/ou nom
// d'utilisateur (comptes existants sans e-mail ni nom d'utilisateur,
// ex. le compte de Riad), description, adresse de livraison par défaut
// et code postal. Champs validés ; e-mail et nom d'utilisateur uniques.
// Au moins un champ doit être fourni. Une chaîne vide efface le champ
// (bio, adresse, code postal) — sauf e-mail et nom d'utilisateur,
// qui doivent rester valides quand ils sont fournis.
authRouter.patch('/auth/me', requireAuth, async (req, res) => {
  const updates = {};
  const setClauses = [];
  const params = [];
  const addSet = (column, value) => {
    params.push(value);
    setClauses.push(`${column} = $${params.length}`);
  };

  if (req.body?.email !== undefined) {
    const email = normalizeEmail(req.body.email);
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
    updates.email = email;
    addSet('email', email);
  }
  if (req.body?.username !== undefined) {
    const username = normalizeUsername(req.body.username);
    if (!isValidUsername(username)) {
      return res.status(400).json({ ok: false, error: 'username_invalid' });
    }
    const taken = await get(
      'SELECT id FROM customers WHERE username = $1 AND id <> $2',
      username, req.customer.id,
    );
    if (taken) {
      return res.status(409).json({ ok: false, error: 'username_taken' });
    }
    updates.username = username;
    addSet('username', username);
  }
  // Description (bio) : texte libre, 200 caractères max. Une chaîne
  // vide l'efface.
  if (req.body?.bio !== undefined) {
    const bio = String(req.body.bio || '').trim();
    if (bio.length > 200) {
      return res.status(400).json({ ok: false, error: 'bio_too_long' });
    }
    updates.bio = bio || null;
    addSet('bio', bio || null);
  }
  // Adresse de livraison par défaut : texte libre, 200 caractères max.
  // Une chaîne vide l'efface (le code postal est effacé aussi).
  if (req.body?.address !== undefined) {
    const address = String(req.body.address || '').trim();
    if (address.length > 200) {
      return res.status(400).json({ ok: false, error: 'address_too_long' });
    }
    updates.address = address || null;
    addSet('address', address || null);
    if (!address) {
      updates.postal_code = null;
      addSet('postal_code', null);
    }
  }
  // Code postal par défaut (format canadien A1A 1A1, comme aux frais).
  // Une chaîne vide l'efface.
  if (req.body?.postal_code !== undefined) {
    const postal = String(req.body.postal_code || '').trim().toUpperCase();
    if (postal !== '' && !/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(postal.replace(/\s+/g, ''))) {
      return res.status(400).json({ ok: false, error: 'postal_invalid' });
    }
    updates.postal_code = postal || null;
    addSet('postal_code', postal || null);
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ ok: false, error: 'nothing_to_update' });
  }
  params.push(req.customer.id);
  const result = await run(
    `UPDATE customers SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    ...params,
  );
  return res.json({ ok: true, customer: publicCustomer(result.rows[0]) });
});

// POST /api/auth/me/photo — photo de profil du client (multipart,
// champ `photo`, JPEG/PNG/WebP, 5 Mo max — mêmes règles que les photos
// produits). Authentifié par le JWT client, PAS par le jeton admin.
// Réponse : { ok: true, photo_url, customer }.
authRouter.post('/auth/me/photo', requireAuth, (req, res) => {
  photoUpload.single('photo')(req, res, async (err) => {
    if (err) {
      const { status, body } = photoUploadError(err);
      return res.status(status).json(body);
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'photo_required' });
    }
    const result = await run(
      'UPDATE customers SET photo_key = $1 WHERE id = $2 RETURNING *',
      req.file.filename, req.customer.id,
    );
    const customer = result.rows[0];
    return res.status(201).json({
      ok: true,
      photo_url: photoUrl(customer.photo_key),
      customer: publicCustomer(customer),
    });
  });
});

// POST /api/auth/change-password — changer son mot de passe (JWT
// client). Le mot de passe actuel doit être correct, sinon erreur
// générique ; le nouveau respecte la même longueur minimale qu'à
// l'inscription (6 caractères).
authRouter.post('/auth/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.current_password || '');
  const newPassword = String(req.body?.new_password || '');
  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'password_too_short' });
  }
  if (!req.customer.password_hash ||
      !bcrypt.compareSync(currentPassword, req.customer.password_hash)) {
    return res.status(400).json({ ok: false, error: 'current_password_invalid' });
  }
  const password_hash = bcrypt.hashSync(newPassword, 10);
  await run(
    'UPDATE customers SET password_hash = $1 WHERE id = $2',
    password_hash, req.customer.id,
  );
  return res.json({ ok: true });
});

// POST /api/auth/logout — jeton JWT sans état : le client jette son jeton.
authRouter.post('/auth/logout', (req, res) => {
  return res.json({ ok: true });
});

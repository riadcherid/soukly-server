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
import { isValidEmail, normalizeEmail, receiptEmailForCustomer } from './email.js';
import { photoUrl, photoUpload, photoUploadError } from './photos.js';
import {
  isLoginBlocked,
  maskEmail,
  recordLoginFailure,
  requestVerificationCode,
  resetLoginFailures,
  verifyCode,
} from './verification.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET non défini — secret de développement utilisé.');
}
const JWT_EXPIRES_IN = '30d';

// Mot de passe des nouveaux comptes : 8 caractères minimum
// (vérification par e-mail, sécurité maximale).
const PASSWORD_MIN_LENGTH = 8;

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

/// Champs d'inscription normalisés depuis le corps de la requête.
function registrationFields(body) {
  return {
    // Le nom complet est facultatif : le nom d'utilisateur suffit.
    name: String(body?.name || '').trim() || null,
    username: normalizeUsername(body?.username),
    phone: normalizePhone(body?.phone),
    password: String(body?.password || ''),
    // E-mail obligatoire à l'inscription (reçu de commande, comme Uber).
    email: normalizeEmail(body?.email),
  };
}

/// Validation des champs d'inscription : renvoie le code d'erreur ou
/// null quand tout est valide (mêmes règles qu'avant, sauf le mot de
/// passe : 8 caractères minimum désormais).
function registrationFieldError({ username, phone, email, password }) {
  if (!isValidUsername(username)) return 'username_invalid';
  if (phone.length < 10) return 'phone_invalid';
  if (!isValidEmail(email)) return 'email_invalid';
  if (password.length < PASSWORD_MIN_LENGTH) return 'password_too_short';
  return null;
}

/// Unicités d'inscription : renvoie le code d'erreur ou null.
async function registrationUniquenessError({ username, phone, email }) {
  const existingUsername = await get(
    'SELECT id FROM customers WHERE username = $1',
    username,
  );
  if (existingUsername) return 'username_taken';
  const existing = await get(
    'SELECT id FROM customers WHERE phone = $1',
    phone,
  );
  if (existing) return 'phone_already_registered';
  const existingEmail = await get(
    'SELECT id FROM customers WHERE email = $1',
    email,
  );
  if (existingEmail) return 'email_already_registered';
  return null;
}

/// Statut HTTP d'une erreur de vérification de code : 400, sauf trop
/// d'essais (429).
function codeErrorStatus(error) {
  return error === 'code_too_many_attempts' ? 429 : 400;
}

/// Retrouve un compte par son identifiant : e-mail, téléphone ou nom
/// d'utilisateur. Le téléphone ne sert que de repli pour les comptes
/// anciens sans e-mail ni nom d'utilisateur (ex. le compte de Riad :
/// téléphone + nom seulement) — un compte qui a un e-mail ou un nom
/// d'utilisateur ne se connecte plus par téléphone. Renvoie la ligne
/// `customers` ou null.
async function findCustomerByIdentifier(identifier) {
  const id = String(identifier ?? '').trim();
  if (id.includes('@')) {
    // E-mail (normalisé : minuscules + trim).
    return get(
      'SELECT * FROM customers WHERE email = $1',
      normalizeEmail(id),
    );
  }
  if (normalizePhone(id).length >= 10) {
    const customer = await get(
      'SELECT * FROM customers WHERE phone = $1',
      normalizePhone(id),
    );
    if (customer && (customer.email || customer.username)) return null;
    return customer;
  }
  // Nom d'utilisateur (insensible à la casse).
  return get(
    'SELECT * FROM customers WHERE username = $1',
    normalizeUsername(id),
  );
}

// POST /api/auth/register — ÉTAPE 1 de l'inscription : valide les
// champs (comme avant) puis envoie le code de vérification par e-mail.
// Ne crée PAS le compte : la création attend
// POST /api/auth/register/verify. Renvoyer la même demande renvoie un
// nouveau code (60 s minimum entre deux envois, 5 codes/heure max).
authRouter.post('/auth/register', async (req, res) => {
  const fields = registrationFields(req.body);
  const fieldError = registrationFieldError(fields);
  if (fieldError) {
    return res.status(400).json({ ok: false, error: fieldError });
  }
  const uniquenessError = await registrationUniquenessError(fields);
  if (uniquenessError) {
    return res.status(409).json({ ok: false, error: uniquenessError });
  }
  const requested = await requestVerificationCode(fields.email, 'register');
  if (!requested.ok) {
    if (requested.error === 'code_resend_too_soon') {
      return res.status(429).json({
        ok: false,
        error: requested.error,
        retry_after_seconds: requested.retry_after_seconds,
      });
    }
    if (requested.error === 'code_rate_limited') {
      return res.status(429).json({ ok: false, error: requested.error });
    }
    // email_not_configured / email_send_failed : l'e-mail n'a pas pu
    // partir (configuration serveur).
    return res.status(502).json({ ok: false, error: requested.error });
  }
  return res.json({ ok: true, code_sent: true });
});

// POST /api/auth/register/verify — ÉTAPE 2 : re-valide les champs +
// unicités, vérifie le code, puis crée le compte (même INSERT
// qu'avant) et renvoie { token, customer } comme l'ancien register.
authRouter.post('/auth/register/verify', async (req, res) => {
  const fields = registrationFields(req.body);
  const code = String(req.body?.code || '').trim();
  const fieldError = registrationFieldError(fields);
  if (fieldError) {
    return res.status(400).json({ ok: false, error: fieldError });
  }
  const uniquenessError = await registrationUniquenessError(fields);
  if (uniquenessError) {
    return res.status(409).json({ ok: false, error: uniquenessError });
  }
  const verified = await verifyCode(fields.email, 'register', code);
  if (!verified.ok) {
    return res
      .status(codeErrorStatus(verified.error))
      .json({ ok: false, error: verified.error });
  }
  const password_hash = bcrypt.hashSync(fields.password, 10);
  const created_at = new Date().toISOString();
  const result = await run(
    `INSERT INTO customers (name, username, phone, email, password_hash, auth_provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    fields.name,
    fields.username,
    fields.phone,
    fields.email,
    password_hash,
    'password',
    created_at,
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
  // sans e-mail ni nom d'utilisateur (voir findCustomerByIdentifier) ;
  // `phone` reste aussi accepté en entrée pour l'ancien client.
  const identifier = String(req.body?.identifier ?? req.body?.phone ?? '').trim();
  const password = String(req.body?.password || '');
  // Blocage après 10 mots de passe faux en 15 min (même identifiant).
  if (isLoginBlocked(identifier)) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }
  const customer = await findCustomerByIdentifier(identifier);
  // Même erreur générique dans tous les cas : on ne révèle jamais si
  // c'est l'identifiant ou le mot de passe qui est faux.
  if (!customer || !customer.password_hash) {
    recordLoginFailure(identifier);
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  if (!bcrypt.compareSync(password, customer.password_hash)) {
    recordLoginFailure(identifier);
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  resetLoginFailures(identifier);
  const email = receiptEmailForCustomer(customer);
  if (!email) {
    // Compte ancien sans e-mail (repli) : pas de code, jeton direct
    // comme avant.
    return res.json({
      ok: true,
      token: signToken(customer),
      customer: publicCustomer(customer),
    });
  }
  // Le mot de passe est bon : on envoie le code de connexion. Le jeton
  // n'est remis qu'après POST /api/auth/login/verify. Renvoyer la même
  // demande renvoie un nouveau code (60 s minimum, 5 codes/heure max).
  const requested = await requestVerificationCode(email, 'login');
  if (!requested.ok) {
    if (requested.error === 'code_resend_too_soon') {
      return res.status(429).json({
        ok: false,
        error: requested.error,
        retry_after_seconds: requested.retry_after_seconds,
      });
    }
    if (requested.error === 'code_rate_limited') {
      return res.status(429).json({ ok: false, error: requested.error });
    }
    return res.status(502).json({ ok: false, error: requested.error });
  }
  return res.json({
    ok: true,
    needs_code: true,
    email_masked: maskEmail(email),
  });
});

// POST /api/auth/login/verify — vérifie le code de connexion puis
// remet le jeton (mot de passe déjà vérifié à l'étape précédente).
authRouter.post('/auth/login/verify', async (req, res) => {
  const identifier = String(req.body?.identifier ?? '').trim();
  const code = String(req.body?.code || '').trim();
  const customer = await findCustomerByIdentifier(identifier);
  if (!customer || !customer.password_hash) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  const email = receiptEmailForCustomer(customer);
  if (!email) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  const verified = await verifyCode(email, 'login', code);
  if (!verified.ok) {
    return res
      .status(codeErrorStatus(verified.error))
      .json({ ok: false, error: verified.error });
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
// l'inscription (8 caractères).
authRouter.post('/auth/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.current_password || '');
  const newPassword = String(req.body?.new_password || '');
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
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

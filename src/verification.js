// Vérification par e-mail (code à 6 chiffres) — sécurité maximale :
// à l'inscription ET à chaque connexion, pour vérifier que le client
// est une vraie personne (l'e-mail doit lui appartenir).
//
// Règles :
// - code à 6 chiffres (crypto.randomInt), valable 10 minutes, usage
//   unique, 5 essais max puis invalidé ;
// - seul le hash SHA-256 du code est stocké, jamais le code en clair,
//   jamais dans les journaux ni dans les réponses de l'API ;
// - un nouveau code invalide les anciens non utilisés (même e-mail +
//   même but) ;
// - renvoi : 60 s minimum entre deux envois (429 `code_resend_too_soon`
//   + `retry_after_seconds`), max 5 codes par e-mail et par heure
//   (429 `code_rate_limited`) ;
// - les erreurs de vérification : `invalid_code` (faux ou déjà
//   utilisé), `code_expired`, `code_too_many_attempts`.
// La connexion Google/Apple n'a pas de code : l'e-mail est déjà vérifié
// par Google/Apple. Les comptes anciens sans e-mail non plus (repli).
import crypto from 'node:crypto';
import { get, run } from './db.js';
import {
  buildVerificationCodeEmail,
  getEmailSettings,
  sendMail,
} from './email.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const RESEND_MIN_MS = 60 * 1000;
export const MAX_CODES_PER_HOUR = 5;

// Blocage des mots de passe : après 10 échecs pour le même identifiant
// en 15 minutes, la connexion est refusée (429 `too_many_attempts`).
// Stockage en mémoire (le serveur est le seul à décider).
export const MAX_LOGIN_ATTEMPTS = 10;
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const loginFailures = new Map();

function loginFailureKey(identifier) {
  return String(identifier || '').trim().toLowerCase();
}

export function isLoginBlocked(identifier) {
  const entry = loginFailures.get(loginFailureKey(identifier));
  if (!entry) return false;
  if (Date.now() - entry.firstAtMs >= LOGIN_ATTEMPT_WINDOW_MS) {
    loginFailures.delete(loginFailureKey(identifier));
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

export function recordLoginFailure(identifier) {
  const key = loginFailureKey(identifier);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.firstAtMs >= LOGIN_ATTEMPT_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAtMs: now });
  } else {
    entry.count += 1;
  }
}

export function resetLoginFailures(identifier) {
  loginFailures.delete(loginFailureKey(identifier));
}

/// Hash SHA-256 du code (hex). Seul ce hash est stocké en base.
export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/// « r***@gmail.com » — l'e-mail masqué renvoyé au client quand un
/// code de connexion est demandé (on ne montre jamais l'adresse entière
/// à quelqu'un qui ne ferait que deviner l'identifiant).
export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${(local || '').slice(0, 1)}***@${domain}`;
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/// Demande (ou renvoie) un code de vérification pour `email` + `purpose`
/// ('register' | 'login'). Renvoie { ok: true } ou
/// { ok: false, error, retry_after_seconds? }.
export async function requestVerificationCode(email, purpose) {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // 60 s minimum entre deux envois (même e-mail + même but).
  const last = await get(
    `SELECT created_at FROM email_verification_codes
     WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    email,
    purpose,
  );
  if (last) {
    const waitMs = RESEND_MIN_MS - (nowMs - new Date(last.created_at).getTime());
    if (waitMs > 0) {
      return {
        ok: false,
        error: 'code_resend_too_soon',
        retry_after_seconds: Math.ceil(waitMs / 1000),
      };
    }
  }

  // Max 5 codes par e-mail et par heure (même but).
  const oneHourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const counted = await get(
    `SELECT COUNT(*)::int AS n FROM email_verification_codes
     WHERE email = $1 AND purpose = $2 AND created_at >= $3`,
    email,
    purpose,
    oneHourAgo,
  );
  if (counted && counted.n >= MAX_CODES_PER_HOUR) {
    return { ok: false, error: 'code_rate_limited' };
  }

  // Un nouveau code invalide les anciens non utilisés.
  await run(
    `UPDATE email_verification_codes SET used_at = $1
     WHERE email = $2 AND purpose = $3 AND used_at IS NULL`,
    nowIso,
    email,
    purpose,
  );

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = hashCode(code);
  const expiresAt = new Date(nowMs + CODE_TTL_MS).toISOString();
  await run(
    `INSERT INTO email_verification_codes
       (email, purpose, code_hash, expires_at, attempts, used_at, created_at)
     VALUES ($1, $2, $3, $4, 0, NULL, $5)`,
    email,
    purpose,
    codeHash,
    expiresAt,
    nowIso,
  );

  const settings = await getEmailSettings();
  const viaBrevo = Boolean(settings.brevo_api_key);
  // Transport JSON (dev local, EMAIL_TEST_TRANSPORT=json) : l'envoi
  // ne touche aucun serveur, aucune adresse ni clé n'est requise.
  const configured =
    process.env.EMAIL_TEST_TRANSPORT === 'json' ||
    (viaBrevo
      ? Boolean(settings.smtp_user)
      : Boolean(settings.smtp_user && settings.smtp_app_password));
  if (!configured) {
    // Aucun e-mail ne peut partir : on retire le code généré.
    await run(
      `DELETE FROM email_verification_codes
       WHERE email = $1 AND purpose = $2 AND code_hash = $3`,
      email,
      purpose,
      codeHash,
    );
    return { ok: false, error: 'email_not_configured' };
  }

  const mail = buildVerificationCodeEmail({ purpose, code });
  try {
    await sendMail({
      settings,
      to: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (err) {
    console.error('[verification] échec d’envoi du code :', err.message);
    await run(
      `DELETE FROM email_verification_codes
       WHERE email = $1 AND purpose = $2 AND code_hash = $3`,
      email,
      purpose,
      codeHash,
    );
    return { ok: false, error: 'email_send_failed' };
  }
  return { ok: true };
}

/// Vérifie un code pour `email` + `purpose`. Renvoie { ok: true } ou
/// { ok: false, error } (`invalid_code`, `code_expired`,
/// `code_too_many_attempts`). Un code réussi est marqué utilisé
/// (usage unique) ; 5 essais faux l'invalident.
export async function verifyCode(email, purpose, code) {
  const nowIso = new Date().toISOString();
  const row = await get(
    `SELECT * FROM email_verification_codes
     WHERE email = $1 AND purpose = $2 AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    email,
    purpose,
  );
  if (!row) return { ok: false, error: 'invalid_code' };

  if (row.expires_at <= nowIso) {
    await run(
      'UPDATE email_verification_codes SET used_at = $1 WHERE id = $2',
      nowIso,
      row.id,
    );
    return { ok: false, error: 'code_expired' };
  }

  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await run(
      'UPDATE email_verification_codes SET used_at = $1 WHERE id = $2',
      nowIso,
      row.id,
    );
    return { ok: false, error: 'code_too_many_attempts' };
  }

  const candidate = String(code || '').trim();
  if (!/^\d{6}$/.test(candidate) || !timingSafeEqualHex(hashCode(candidate), row.code_hash)) {
    const attempts = row.attempts + 1;
    await run(
      'UPDATE email_verification_codes SET attempts = $1 WHERE id = $2',
      attempts,
      row.id,
    );
    if (attempts >= CODE_MAX_ATTEMPTS) {
      await run(
        'UPDATE email_verification_codes SET used_at = $1 WHERE id = $2',
        nowIso,
        row.id,
      );
      return { ok: false, error: 'code_too_many_attempts' };
    }
    return { ok: false, error: 'invalid_code' };
  }

  await run(
    'UPDATE email_verification_codes SET used_at = $1 WHERE id = $2',
    nowIso,
    row.id,
  );
  return { ok: true };
}

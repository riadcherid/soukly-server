// Reçu de commande par e-mail (comme Uber) — envoi via Gmail SMTP
// (smtp.gmail.com:587, STARTTLS) avec un mot de passe d'application
// Google. La configuration vit dans la table `settings` (clé `email`) :
// smtp_user (adresse Gmail), smtp_app_password (masqué, jamais renvoyé
// en clair), smtp_from_name (« Soukly »).
//
// Le reçu part quand une commande est marquée « terminee » (une seule
// fois : `receipt_email_sent_at` n'est mis que si l'envoi réussit).
// L'envoi est asynchrone : un échec ne bloque jamais le changement de
// statut, il est seulement journalisé.
//
// Dev local uniquement : avec la variable d'environnement
// EMAIL_TEST_TRANSPORT=json, l'envoi ne touche pas Gmail — nodemailer
// génère le message en mémoire (transport JSON). Sur Render (sans cette
// variable), c'est le vrai Gmail qui est utilisé.
import nodemailer from 'nodemailer';
import { all, get, run } from './db.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/// Normalise une adresse e-mail (minuscules + espaces retirés).
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/// Format simple d'une adresse e-mail.
export function isValidEmail(email) {
  return EMAIL_REGEX.test(normalizeEmail(email));
}

/// Adresse e-mail du client pour le reçu : `email` si définie, sinon
/// `google_email` (compte Google / Apple).
export function receiptEmailForCustomer(customer) {
  if (!customer) return null;
  return customer.email || customer.google_email || null;
}

/// « 4,98 $ » — format français.
function formatCentsFr(cents) {
  return `${((cents || 0) / 100).toFixed(2).replace('.', ',')} $`;
}

/// « 500 g » ou « 1,5 kg ».
function formatWeightFr(grams) {
  if (grams >= 1000 && grams % 1000 === 0) return `${grams / 1000} kg`;
  if (grams >= 1000) return `${(grams / 1000).toFixed(1).replace('.', ',')} kg`;
  return `${grams} g`;
}

function formatDateFr(iso) {
  try {
    return new Date(iso).toLocaleString('fr-CA', {
      timeZone: 'America/Toronto',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso || '');
  }
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/// Construit le reçu (objet + corps texte + corps HTML rouge/blanc).
/// `order` : ligne de la table orders ; `items` : lignes order_items ;
/// `customerName` : nom du client.
export function buildReceiptEmail({ order, items, customerName }) {
  const mode = order.mode === 'livraison' ? 'Livraison' : 'Cueillette';
  const total = order.final_total_cents ?? order.total_cents;
  const date = formatDateFr(order.created_at);

  // Articles reçus seulement (collectés ou manquants), comme le bon de
  // livraison final : les articles encore à collecter n'y figurent pas.
  const received = (items || []).filter(
    (it) => it.status === 'collecte' || it.status === 'manquant',
  );
  const itemLines = received.map((it) => {
    const weight = it.collected_weight_grams != null
      ? `Poids final : ${formatWeightFr(it.collected_weight_grams)}`
      : it.weight_grams != null
        ? `Environs ${formatWeightFr(it.weight_grams)}`
        : `${it.quantity} ×`;
    const missing = it.status === 'manquant' ? ' (manquant)' : '';
    return {
      name: it.product_name,
      detail: weight,
      missing,
      total: formatCentsFr(it.line_total_cents),
    };
  });

  const rows = [
    ...(order.delivery_fee_cents > 0
      ? [['Livraison', formatCentsFr(order.delivery_fee_cents)]] : []),
    ...(order.service_fee_cents > 0
      ? [['Frais de service', formatCentsFr(order.service_fee_cents)]] : []),
    ...(order.tip_cents > 0
      ? [['Pourboire livreur', formatCentsFr(order.tip_cents)]] : []),
    ...(order.tps_cents > 0
      ? [['TPS (5 %)', formatCentsFr(order.tps_cents)]] : []),
    ...(order.tvq_cents > 0
      ? [['TVQ (9,975 %)', formatCentsFr(order.tvq_cents)]] : []),
  ];

  const textLines = [
    `Soukly — Votre marché partout`,
    ``,
    `Merci ${customerName || 'cher client'} ! Voici le reçu de votre commande n° ${order.id} (${mode}, ${date}).`,
    ``,
    ...itemLines.map((l) => `- ${l.name} — ${l.detail}${l.missing} : ${l.total}`),
    ``,
    ...rows.map(([label, value]) => `${label} : ${value}`),
    `Total : ${formatCentsFr(total)}`,
    ``,
    `À bientôt chez Soukly !`,
  ];

  const itemRowsHtml = itemLines.map((l) => `
      <tr>
        <td style="padding:6px 0;">${escapeHtml(l.name)}<br>
          <span style="color:#666;font-size:13px;">${escapeHtml(l.detail)}${escapeHtml(l.missing)}</span>
        </td>
        <td style="padding:6px 0;text-align:right;">${escapeHtml(l.total)}</td>
      </tr>`).join('');

  const feeRowsHtml = rows.map(([label, value]) => `
      <tr>
        <td style="padding:4px 0;color:#555;">${escapeHtml(label)}</td>
        <td style="padding:4px 0;text-align:right;">${escapeHtml(value)}</td>
      </tr>`).join('');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
    <div style="background:#D32F2F;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
      <div style="font-size:24px;font-weight:bold;">Soukly</div>
      <div style="font-size:14px;">Votre marché partout</div>
    </div>
    <div style="border:1px solid #eee;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
      <h2 style="margin:0 0 4px;">Reçu de votre commande n° ${order.id}</h2>
      <p style="margin:0 0 16px;color:#555;">${mode} — ${escapeHtml(date)}</p>
      <p style="margin:0 0 4px;"><strong>${escapeHtml(customerName || 'Client')}</strong></p>
      ${order.address ? `<p style="margin:0;">${escapeHtml(order.address)}${order.postal_code ? `, ${escapeHtml(order.postal_code)}` : ''}</p>` : ''}
      ${order.phone ? `<p style="margin:0;">Tél : ${escapeHtml(order.phone)}</p>` : ''}
      ${order.note ? `<p style="margin:8px 0 0;">Note : ${escapeHtml(order.note)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;margin:16px 0 8px;border-top:2px solid #D32F2F;">
        ${itemRowsHtml}
      </table>
      <table style="width:100%;border-collapse:collapse;">
        ${feeRowsHtml}
        <tr>
          <td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total</td>
          <td style="padding:8px 0 0;text-align:right;font-weight:bold;color:#D32F2F;border-top:1px solid #ddd;">${escapeHtml(formatCentsFr(total))}</td>
        </tr>
      </table>
      <p style="margin:20px 0 0;color:#666;font-size:13px;">Merci de votre commande — à bientôt chez Soukly !</p>
    </div>
  </div>`;

  return {
    subject: `Soukly — Reçu de votre commande n° ${order.id}`,
    text: textLines.join('\n'),
    html,
  };
}

export function emailSettingsFromStore(stored) {
  return {
    smtp_user: stored?.smtp_user || process.env.SMTP_USER || '',
    smtp_app_password:
      stored?.smtp_app_password || process.env.SMTP_APP_PASSWORD || '',
    smtp_from_name: stored?.smtp_from_name || 'Soukly',
  };
}

// Lecture directe de la table `settings` (évite un import circulaire
// avec admin.js, qui importe ce module pour les réglages e-mail).
async function readStoredEmailSettings() {
  const row = await get('SELECT value FROM settings WHERE key = $1', 'email');
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export async function getEmailSettings() {
  const stored = await readStoredEmailSettings();
  return emailSettingsFromStore(stored);
}

/// Transport nodemailer : vrai Gmail SMTP, sauf en dev local avec
/// EMAIL_TEST_TRANSPORT=json (message généré en mémoire, jamais envoyé).
function createMailTransport(settings) {
  if (process.env.EMAIL_TEST_TRANSPORT === 'json') {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    auth: { user: settings.smtp_user, pass: settings.smtp_app_password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

async function sendMail({ settings, to, subject, text, html }) {
  const transport = createMailTransport(settings);
  const fromName = settings.smtp_from_name || 'Soukly';
  const info = await transport.sendMail({
    from: `"${fromName}" <${settings.smtp_user}>`,
    to,
    subject,
    text,
    html,
  });
  return info;
}

/// Envoie un e-mail de test à l'adresse Gmail configurée.
/// Renvoie { ok, to } ou { ok: false, error } (message réel de Gmail).
export async function sendTestEmail() {
  const settings = await getEmailSettings();
  if (!settings.smtp_user || !settings.smtp_app_password) {
    return { ok: false, error: 'email_not_configured' };
  }
  try {
    const info = await sendMail({
      settings,
      to: settings.smtp_user,
      subject: 'Soukly — Test d’envoi e-mail',
      text: 'Si vous lisez ce message, l’envoi d’e-mails Soukly fonctionne.',
      html: '<p>Si vous lisez ce message, l’envoi d’e-mails Soukly fonctionne.</p>',
    });
    return { ok: true, to: settings.smtp_user, messageId: info?.messageId || null };
  } catch (err) {
    console.error('[email/test]', err.message);
    return { ok: false, error: err.message };
  }
}

async function loadOrderForReceipt(orderId) {
  const order = await get(
    `SELECT o.*, COALESCE(c.name, c.username) AS customer_name, c.email AS customer_email,
            c.google_email AS customer_google_email
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    orderId,
  );
  if (!order) return null;
  const items = await all(
    'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
    orderId,
  );
  return { order, items };
}

/// Envoie le reçu d'une commande au client (une seule fois).
/// Renvoie { ok, sent, reason } — `sent` faux si rien n'a été envoyé
/// (pas d'e-mail client, pas de config SMTP, déjà envoyé, commande
/// introuvable). Ne lève jamais : l'appelant (déclencheur) ne doit pas
/// échouer à cause de l'e-mail.
export async function sendOrderReceipt(orderId) {
  try {
    const loaded = await loadOrderForReceipt(orderId);
    if (!loaded) return { ok: false, sent: false, reason: 'order_not_found' };
    const { order, items } = loaded;
    if (order.receipt_email_sent_at) {
      return { ok: false, sent: false, reason: 'already_sent' };
    }
    const to = receiptEmailForCustomer({
      email: order.customer_email,
      google_email: order.customer_google_email,
    });
    if (!to) return { ok: false, sent: false, reason: 'no_customer_email' };
    const settings = await getEmailSettings();
    if (!settings.smtp_user || !settings.smtp_app_password) {
      return { ok: false, sent: false, reason: 'email_not_configured' };
    }
    const mail = buildReceiptEmail({
      order,
      items,
      customerName: order.customer_name,
    });
    await sendMail({ settings, to, subject: mail.subject, text: mail.text, html: mail.html });
    const now = new Date().toISOString();
    await run(
      `UPDATE orders SET receipt_email_sent_at = $1
       WHERE id = $2 AND receipt_email_sent_at IS NULL`,
      now, orderId,
    );
    console.log(`[receipt] reçu envoyé à ${to} pour la commande n° ${orderId}`);
    return { ok: true, sent: true, sent_at: now, to };
  } catch (err) {
    console.error(`[receipt] échec d'envoi pour la commande n° ${orderId} :`, err.message);
    return { ok: false, sent: false, reason: 'send_failed', error: err.message };
  }
}

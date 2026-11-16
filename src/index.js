// Serveur API REST Soukly — appli mobile (Flutter, Android + iOS).
// Voir plan : ../files/plan-appli-mobile-flutter.md (§4 tableau des routes).
import 'dotenv/config';
import express from 'express';
import { initSchema } from './db.js';
import { seedCatalogIfEmpty } from './seed.js';
import { catalogRouter } from './catalog.js';
import { authRouter } from './auth.js';
import { ordersRouter } from './orders.js';
import { adminRouter } from './admin.js';
import { googleRouter } from './google.js';
import { imagesRouter, uploadRouter } from './photos.js';
import { quoteFees } from './fees.js';
import { PRIVACY_HTML } from './privacy.js';
import { addressRouter } from './address.js';

await initSchema();

// Base neuve (ex. premier démarrage sur Render) : on remplit le catalogue
// depuis catalog.json. Sinon on ne touche à rien (prix du matin préservés).
await seedCatalogIfEmpty();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'soukly-server', version: '0.5.8' });
});

// Page de confidentialité (URL exigée par Google Play et l'App Store).
app.get('/privacy', (req, res) => {
  res.type('html').send(PRIVACY_HTML);
});

app.use('/api', catalogRouter);
app.use('/api', authRouter);
app.use('/api', ordersRouter);
app.use('/api', addressRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin', uploadRouter);
app.use('/api/images', imagesRouter);
app.use('/api', googleRouter);

app.post('/api/fees/quote', (req, res) => {
  const { postal_code, mode } = req.body || {};
  if (mode !== 'livraison' && mode !== 'cueillette') {
    return res.status(400).json({ ok: false, error: 'mode_invalid' });
  }
  return res.json({ ok: true, ...quoteFees({ postal_code, mode }) });
});

// 404 JSON pour les routes API inconnues.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// Gestionnaire d'erreurs — jamais de trace brute au client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Soukly API en écoute sur http://localhost:${PORT}`);
});

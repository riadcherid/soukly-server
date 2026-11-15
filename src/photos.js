// Photos produits — upload admin (multipart) et service public des images.
// Comble la lacune notée dans app/README.md : l'appli Flutter admin ne
// pouvait pas envoyer de photo (POST /api/admin/products est en JSON et
// n'accepte qu'une image_key en chaîne), et aucune route ne servait les
// images (photo_url toujours null dans le catalogue).
// Les fichiers vivent sous server/data/uploads/ (dans ~/workspace, donc
// ils survivent à un remplacement de VM, contrairement à Postgres apt).
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { requireAdmin } from './admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 Mo

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// URL publique d'une photo à partir de son image_key, null sinon.
export function photoUrl(image_key) {
  if (!image_key) return null;
  return `/api/images/${encodeURIComponent(String(image_key))}`;
}

// Nom unique : horodatage + 8 octets aléatoires + extension selon le type MIME
// (jamais le nom d'origine, pour éviter toute injection de chemin).
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = MIME_TO_EXT[file.mimetype] || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (MIME_TO_EXT[file.mimetype]) return cb(null, true);
    return cb(new Error('invalid_file_type'));
  },
});

// --- Upload admin (multipart) ---

export const uploadRouter = Router();

// POST /api/admin/upload-photo — envoyer une photo produit.
// Champ multipart : `photo` (JPEG/PNG/WebP, max 5 Mo).
// Réponse : { ok: true, image_key, mime_type, size }.
// L'image_key est ensuite à passer à POST /api/admin/products.
uploadRouter.post('/upload-photo', requireAdmin, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ ok: false, error: 'file_too_large' });
      }
      if (err.message === 'invalid_file_type') {
        return res.status(400).json({ ok: false, error: 'invalid_file_type' });
      }
      return res.status(400).json({ ok: false, error: 'upload_error' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'photo_required' });
    }
    return res.status(201).json({
      ok: true,
      image_key: req.file.filename,
      mime_type: req.file.mimetype,
      size: req.file.size,
    });
  });
});

// --- Service public des images ---

export const imagesRouter = Router();

// GET /api/images/:key — servir une photo uploadée (lecture publique).
// La clé est validée (caractères sûrs uniquement, extension image) pour
// empêcher toute traversée de chemin hors du dossier d'upload.
imagesRouter.get('/:key', (req, res) => {
  const key = String(req.params.key || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || key.includes('..')) {
    return res.status(404).json({ ok: false, error: 'image_not_found' });
  }
  const ext = path.extname(key).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) {
    return res.status(404).json({ ok: false, error: 'image_not_found' });
  }
  const filePath = path.resolve(UPLOAD_DIR, key);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    return res.status(404).json({ ok: false, error: 'image_not_found' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'image_not_found' });
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(filePath);
});

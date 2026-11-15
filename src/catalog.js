// GET /api/catalog — rayons, produits, prix et dispos du jour, inventaire.
// Miroir de l'action `listcatalog` de l'appli web. Même forme de réponse.
import { Router } from 'express';
import { all, get } from './db.js';
import { photoUrl } from './photos.js';

export const catalogRouter = Router();

function toProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category_key,
    unit: row.unit,
    price_cents: row.price_cents,
    sold_by_weight: row.sold_by_weight === true,
    available: row.available === true,
    image_key: row.image_key,
    photo_url: photoUrl(row.image_key),
  };
}

catalogRouter.get('/catalog', async (req, res) => {
  const categories = await all('SELECT key, label, sort FROM categories ORDER BY sort');
  const products = (await all('SELECT * FROM products ORDER BY id')).map(toProduct);
  const inv = await get('SELECT date, note, updated_at FROM inventory WHERE id = 1');
  res.json({
    ok: true,
    categories,
    products,
    inventory: inv || { date: null, note: null, updated_at: null },
    today: new Date().toISOString().slice(0, 10),
  });
});

// Suggestions d'adresse pour la livraison, via OpenStreetMap Nominatim
// (gratuit, sans clé ni compte). C'est le serveur qui appelle Nominatim :
// l'appli n'a jamais besoin de l'appeler directement.
//
// Le client tape son adresse à la main et se trompe souvent de code
// postal (format A1A 1A1 requis, sinon la commande est refusée) : la
// suggestion remplit l'adresse ET le code postal d'un coup.
//
// La route ne fait jamais échouer le paiement : requête trop courte,
// erreur ou délai de Nominatim → liste vide, la saisie manuelle reste
// possible.
import express from 'express';
import { fetchJson } from './http.js';

export const addressRouter = express.Router();

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Soukly/1.0 (riadcherid@gmail.com)';
const TIMEOUT_MS = 5000;

// Une suggestion : adresse (rue + numéro), code postal et ville.
// Le code postal peut être absent (null) : l'appli ne remplit alors
// que l'adresse et le client tape le code postal à la main.
function toSuggestion(place) {
  const a = place.address || {};
  const house = a.house_number ? String(a.house_number) : '';
  const road = a.road ? String(a.road) : '';
  const address = [house, road].filter(Boolean).join(' ');
  if (!address) return null;
  const city =
    a.city || a.town || a.village || a.municipality || a.suburb || '';
  return {
    label: place.display_name || address,
    address,
    postal_code: a.postcode ? String(a.postcode) : null,
    city: String(city),
  };
}

addressRouter.get('/address/suggest', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ ok: true, suggestions: [] });
  try {
    const params = new URLSearchParams({
      q,
      countrycodes: 'ca',
      addressdetails: '1',
      limit: '5',
      format: 'json',
    });
    const { ok, data } = await fetchJson(`${NOMINATIM_URL}?${params}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr',
      },
    }, TIMEOUT_MS);
    if (!ok || !Array.isArray(data)) {
      return res.json({ ok: true, suggestions: [] });
    }
    const suggestions = data
      .map(toSuggestion)
      .filter((s) => s !== null);
    return res.json({ ok: true, suggestions });
  } catch {
    return res.json({ ok: true, suggestions: [] });
  }
});

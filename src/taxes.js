// Taxes TPS / TVQ — règles confirmées par Riad (2026-11-15).
// Prix affichés hors taxes ; taxes calculées et ajoutées au total.
// TPS 5 %, TVQ 9,975 % calculée sur (prix + TPS) — méthode québécoise.
// Arrondi à l'entier (cent) par ligne, au plus proche (Math.round).
//
// Par rayon (défaut) :
// - DÉTAXÉS (0 %) : fruits, légumes, viandes halal, volailles,
//   poissons et fruits de mer, produits laitiers et œufs, boulangerie,
//   épicerie sèche, surgelés, produits orientaux et maghrébins.
// - TAXABLES TPS + TVQ : boissons, produits ménagers et hygiène,
//   restauration, glaces et desserts glacés, produits pour animaux.
// - PÂTISSERIE : moins de 6 pièces du même produit → TPS seulement
//   (plus de TVQ depuis juillet 2026) ; 6 pièces ou plus → aucune taxe.
// - Vendu au poids → AUCUNE taxe, quel que soit le rayon.
// - Aliment préparé / fast-food (ex. pizza) → taxable TPS + TVQ
//   (indicateur `prepared` sur le produit ; les 3 préparés sont en
//   Restauration depuis v0.7.18, le drapeau reste la garantie).
// - Détaxation par produit (`tax_exempt` sur le produit, ex. le café,
//   Riad 2026-11-19) : annule la taxe quel que soit le rayon.
// - Frais de livraison et frais de service → taxables TPS + TVQ.
// - Rayons sans règle propre (épicerie bio et produits naturels,
//   produits pour bébés) : détaxés par défaut ; affinés produit par
//   produit si besoin. Les anciennes clés (grignotines, jouets et jeux,
//   fleurs et plantes, fête, santé, promotions) ont disparu en v0.7.18
//   avec leurs rayons vides : les retirer de TAXABLE_CATEGORIES est
//   sans effet, aucun produit ne les utilisait.

export const TPS_RATE = 0.05;
export const TVQ_RATE = 0.09975;

// Rayons taxables TPS + TVQ (clés de la table categories).
export const TAXABLE_CATEGORIES = new Set([
  'boissons',
  'produits-menagers-et-hygiene',
  'restauration',
  'glaces-et-desserts-glaces',
  'produits-pour-animaux',
]);

const PATISSERIE_CATEGORY = 'patisserie';
// Seuil pâtisserie : 6 pièces ou plus du même produit → détaxé.
const PATISSERIE_TAX_FREE_MIN_QTY = 6;

/// Taxe d'un montant en cents : TPS 5 % puis TVQ 9,975 % sur (montant + TPS).
/// Renvoie { tps, tvq } en cents (entiers, arrondis au plus proche).
/// Arithmétique entière (pas de flottants) pour que le calcul soit
/// identique côté serveur et côté appli.
export function taxOnAmount(amountCents) {
  const tps = Math.floor((amountCents * 5 + 50) / 100);
  const tvq = Math.floor(((amountCents + tps) * 9975 + 50000) / 100000);
  return { tps, tvq };
}

/// Taxe d'une ligne de commande.
/// line = { categoryKey, soldByWeight, prepared, taxExempt, quantity, lineTotalCents }.
/// - Produit détaxé (`taxExempt`, ex. le café) → 0, quel que soit le rayon.
/// - Vendu au poids → 0.
/// - Pâtisserie : quantité >= 6 → 0 ; sinon TPS seulement.
/// - Produit préparé ou rayon taxable → TPS + TVQ.
/// - Sinon (rayons de base, rayon inconnu) → 0.
export function taxForLine(line) {
  const total = Math.max(0, Math.floor(Number(line.lineTotalCents) || 0));
  if (total === 0) return { tps: 0, tvq: 0 };
  if (line.taxExempt === true) return { tps: 0, tvq: 0 };
  if (line.soldByWeight === true) return { tps: 0, tvq: 0 };
  if (line.categoryKey === PATISSERIE_CATEGORY) {
    const qty = Math.floor(Number(line.quantity) || 1);
    if (qty >= PATISSERIE_TAX_FREE_MIN_QTY) return { tps: 0, tvq: 0 };
    return { tps: Math.floor((total * 5 + 50) / 100), tvq: 0 };
  }
  if (line.prepared === true || TAXABLE_CATEGORIES.has(line.categoryKey)) {
    return taxOnAmount(total);
  }
  return { tps: 0, tvq: 0 };
}

/// Taxes totales d'une commande.
/// lines : lignes avec { categoryKey, soldByWeight, prepared, taxExempt,
///   quantity, lineTotalCents } ; deliveryFeeCents / serviceFeeCents : frais taxables.
/// Renvoie { tps_cents, tvq_cents }.
export function computeOrderTaxes(lines, deliveryFeeCents, serviceFeeCents) {
  let tps = 0;
  let tvq = 0;
  for (const line of lines || []) {
    const t = taxForLine(line);
    tps += t.tps;
    tvq += t.tvq;
  }
  for (const fee of [deliveryFeeCents, serviceFeeCents]) {
    const amount = Math.max(0, Math.floor(Number(fee) || 0));
    if (amount > 0) {
      const t = taxOnAmount(amount);
      tps += t.tps;
      tvq += t.tvq;
    }
  }
  return { tps_cents: tps, tvq_cents: tvq };
}

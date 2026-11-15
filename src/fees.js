// Frais de livraison et de service — règles fixées par Riad (2026-11-14).
// Livraison : 2,99 $ Saint-Laurent (H4L), 4,99 $ reste de Montréal,
// 7,99 $ plus loin (Laval, Longueuil, environs).
// Service : 4,99 $ en livraison, 2,99 $ en cueillette.
// Prix en cents. Le code postal canadien est validé (format A1A 1A1).

const SERVICE_DELIVERY_CENTS = 499;
const SERVICE_PICKUP_CENTS = 299;

export function quoteFees({ postal_code, mode }) {
  if (mode === 'cueillette') {
    return {
      postal_valid: true,
      delivery_zone: 'cueillette',
      delivery_fee_cents: 0,
      service_fee_cents: SERVICE_PICKUP_CENTS,
    };
  }

  const postal = String(postal_code || '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(postal)) {
    return {
      postal_valid: false,
      delivery_zone: null,
      delivery_fee_cents: null,
      service_fee_cents: SERVICE_DELIVERY_CENTS,
    };
  }

  const fsa = postal.slice(0, 3);
  let delivery_zone;
  let delivery_fee_cents;
  if (fsa === 'H4L') {
    delivery_zone = 'saint-laurent';
    delivery_fee_cents = 299;
  } else if (fsa.startsWith('H') && !fsa.startsWith('H7')) {
    delivery_zone = 'montreal';
    delivery_fee_cents = 499;
  } else {
    delivery_zone = 'plus-loin';
    delivery_fee_cents = 799;
  }

  return {
    postal_valid: true,
    delivery_zone,
    delivery_fee_cents,
    service_fee_cents: SERVICE_DELIVERY_CENTS,
  };
}

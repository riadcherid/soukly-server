# Serveur API Soukly — appli mobile (Flutter, Android + iOS)

API REST pour la future appli mobile Soukly. Plan complet :
`../files/plan-appli-mobile-flutter.md` (§3 architecture, §4 routes, §6 plan).

## Démarrer

```bash
npm install
npm run seed   # crée la base locale et migre le catalogue de l'appli web
npm start      # écoute sur http://localhost:3000
```

La configuration se lit dans `.env` (voir `.env.example`). Sans `.env`,
les valeurs de développement par défaut sont utilisées (avec avertissement
pour `JWT_SECRET` ; les routes admin sont fermées sans `ADMIN_TOKEN`).

## Base de données

**Postgres 16 local** (base `soukly`, utilisateur `soukly`, port 5432).
Démarrer le cluster si besoin : `pg_ctlcluster 16 main start`.
Connexion via `DATABASE_URL` (voir `.env.example` ; le mot de passe
`soukly-dev-only` est un mot de passe de développement local uniquement).
La production utilisera Postgres hébergée (Supabase, Neon ou Railway)
comme prévu dans le plan — même schéma, il suffira de changer
`DATABASE_URL`.

## Routes (v0.5.5)

| Route | Rôle | Auth |
|---|---|---|
| `GET /api/health` | Santé du serveur | — |
| `GET /api/address/suggest?q=...` | Suggestions d'adresse (Nominatim, min. 3 caractères) | — |
| `GET /api/catalog` | Rayons, produits, prix et dispos, inventaire du matin | — |
| `GET /api/images/:key` | Servir une photo produit uploadée (lecture publique) | — |
| `POST /api/admin/upload-photo` | Envoyer une photo produit (multipart, JPEG/PNG/WebP, max 5 Mo) | Admin |
| `POST /api/auth/register` | Compte client (nom d'utilisateur, téléphone, e-mail, mot de passe — les 4 obligatoires ; nom complet facultatif) | — |
| `POST /api/auth/login` | Connexion nom d'utilisateur ou e-mail + mot de passe (repli téléphone pour les comptes anciens, voir ci-dessous) | — |
| `POST /api/auth/logout` | Déconnexion (jeton JWT sans état : le client jette son jeton) | — |
| `GET /api/auth/me` | Client connecté | Bearer (client) |
| `PATCH /api/auth/me` | Ajouter / modifier son e-mail et/ou son nom d'utilisateur (validés, uniques) | Bearer (client) |
| `POST /api/auth/google` | Échange du code Google côté serveur, compte par courriel vérifié | — |
| `POST /api/auth/apple` | Vérification du jeton d'identité Apple (iOS) | — |
| `GET /api/config/google` | Identifiant client Google public + connexion activée | — |
| `POST /api/fees/quote` | Frais de livraison et de service selon le code postal | — |
| `POST /api/orders` | Créer une commande (livraison / cueillette, pourboire livreur) | Bearer (client) |
| `GET /api/orders/mine` | Commandes du client connecté | Bearer (client) |
| `GET /api/orders` | Toutes les commandes (filtre `?status=`, `?limit=`) — chaque commande renvoie aussi `customer_name` (nom du client, jointure sur `customers`), `customer_email` et `receipt_email_sent_at` | Admin |
| `DELETE /api/admin/customers` | Supprimer TOUS les comptes clients et leurs commandes (réinscription propre) — ne touche ni aux produits, ni aux rayons, ni aux réglages, ni à l'inventaire | Admin |
| `PATCH /api/orders/{id}/status` | Statut : reçue, en préparation, prête, terminée, annulée — passer à « terminée » envoie le reçu par e-mail au client (une seule fois) | Admin |
| `POST /api/admin/orders/{id}/resend-receipt` | Renvoyer le reçu par e-mail (client avec e-mail, reçu pas encore envoyé) | Admin |
| `PATCH /api/orders/{id}/items/{itemId}/status` | Collecte : collecté / manquant (+ remplacement) | Admin |
| `PATCH /api/orders/{id}/items/{itemId}/weight` | Poids réel pesé en grammes → montant final | Admin |
| `POST /api/admin/products` | Ajouter / modifier un produit (`price_unit` : 'piece' \| 'lb' \| 'kg', `on_special` : prix spécial) | Admin |
| `DELETE /api/admin/products/{id}` | Retirer un produit (409 s'il est dans une commande) | Admin |
| `POST /api/admin/categories` | Ajouter / renommer un rayon | Admin |
| `POST /api/admin/inventory` | Inventaire du matin (prix et dispos du jour, unité `price_unit` et `on_special` facultatifs par produit) | Admin |
| `GET /api/admin/ai-settings` | Réglages IA (clé masquée, jamais en clair) | Admin |
| `POST /api/admin/ai-settings` | Enregistrer fournisseur IA + clé | Admin |
| `POST /api/admin/ai/describe-photo` | Description IA en français depuis une photo | Admin |
| `POST /api/admin/ai/test-key` | Tester la clé IA | Admin |
| `GET /api/admin/google-settings` | Réglages Google (secret masqué) | Admin |
| `POST /api/admin/google-settings` | Enregistrer identifiant + secret Google | Admin |
| `POST /api/admin/google/test` | Tester la config Google chez Google | Admin |
| `GET /api/admin/email-settings` | Réglages e-mail Gmail (mot de passe d'application masqué) | Admin |
| `POST /api/admin/email-settings` | Enregistrer adresse Gmail + mot de passe d'application | Admin |
| `POST /api/admin/email/test` | Envoyer un e-mail de test à l'adresse Gmail configurée | Admin |

Frais (règles de Riad, 2026-11-14) : livraison 2,99 $ Saint-Laurent (H4L),
4,99 $ reste de Montréal, 7,99 $ plus loin ; service 4,99 $ livraison /
2,99 $ cueillette. Prix en cents, poids en grammes.

### Nom d'utilisateur et connexion au choix (v0.5.5)

- Chaque compte a un `username` : obligatoire à l'inscription, unique,
  insensible à la casse (stocké en minuscules), 3 à 30 caractères
  (lettres, chiffres, `.` `_` `-`) — erreurs `username_invalid` /
  `username_taken`. Le nom complet est facultatif à l'inscription ;
  l'affichage (bon de livraison, reçu e-mail, liste admin) retombe sur
  le nom d'utilisateur quand il est absent (`COALESCE(name, username)`).
- La connexion accepte le nom d'utilisateur OU l'e-mail + mot de passe
  (`POST /api/auth/login`, champ `identifier` ; `phone` reste accepté
  en entrée pour l'ancien client). Même erreur générique
  `invalid_credentials` dans tous les cas (pas d'énumération de compte).
- Repli téléphone (serveur seulement, jamais proposé dans l'appli) :
  un identifiant tout en chiffres (≥10 après nettoyage) est cherché
  par téléphone, mais accepté uniquement si le compte trouvé n'a NI
  e-mail NI nom d'utilisateur — les comptes créés avant le nom
  d'utilisateur (ex. celui de Riad). Un compte qui a un e-mail ou un
  nom d'utilisateur ne se connecte plus par téléphone.
- `PATCH /api/auth/me` accepte `email` et/ou `username` (validés,
  uniques) pour les comptes existants sans e-mail ni nom d'utilisateur.

### Unité de prix flexible et prix spécial (v0.5.4)

- Chaque produit a une unité de prix `price_unit` : `'piece'` (vendu à
  l'unité, prix à la pièce), `'lb'` ou `'kg'` (vendu au poids, prix stocké
  au kg ; saisie/affichage en $/lb ou en $/kg). Le client qui achète au
  poids entre toujours des grammes ; le total se calcule depuis le prix
  au kg. `sold_by_weight` est dérivé de `price_unit` dans les réponses
  (`'lb'` | `'kg'` = au poids).
- `on_special` (booléen, défaut false) : un produit coché « Spécial »
  reste dans son rayon d'origine ET apparaît dans le rayon « Promotions »
  de la boutique (filtre côté client, badge « Spécial »). Pas d'ancien
  prix ni de prix barré pour l'instant.

### Reçu de commande par e-mail (Gmail, v0.5.3)

- L'e-mail du client est **obligatoire à l'inscription** (`POST
  /api/auth/register` : format valide, unique — erreurs `email_invalid`
  / `email_already_registered`). Les comptes existants sans e-mail
  peuvent l'ajouter via `PATCH /api/auth/me` (validé, unique). Pour le
  reçu, on utilise `email` si défini, sinon `google_email` (compte
  Google / Apple).
- Quand une commande passe à « terminée » (et seulement à ce moment-là,
  une seule fois), le serveur envoie le reçu par e-mail au client :
  objet « Soukly — Reçu de votre commande n° X », corps HTML rouge/blanc
  + version texte (n° de commande, nom, adresse, téléphone, mode, date,
  articles avec poids final pesé, frais, pourboire, TPS / TVQ, total
  final). L'envoi est asynchrone : un échec ne bloque jamais le
  changement de statut (journalisé seulement) ; `receipt_email_sent_at`
  n'est mis que si l'envoi réussit. Renvoi manuel :
  `POST /api/admin/orders/{id}/resend-receipt` (409
  `receipt_already_sent` si déjà envoyé, 400 `no_customer_email` si le
  client n'a pas d'e-mail).
- Envoi via **Gmail SMTP** (smtp.gmail.com:587, STARTTLS) avec un mot de
  passe d'application Google : configuration dans la table `settings`
  (clé `email`) via `GET` / `POST /api/admin/email-settings`
  (`smtp_user`, `smtp_app_password` masqué, `smtp_from_name` « Soukly »),
  ou variables d'environnement `SMTP_USER` / `SMTP_APP_PASSWORD`.
  `POST /api/admin/email/test` envoie un e-mail de test à l'adresse
  configurée et renvoie l'erreur réelle de Gmail en cas d'échec. Le mot
  de passe d'application se crée dans le compte Google (Sécurité →
  Validation en deux étapes → Mots de passe des applications) — il ne
  doit jamais être partagé en clair.
- Dev local uniquement : avec `EMAIL_TEST_TRANSPORT=json`, l'envoi ne
  touche pas Gmail (transport JSON nodemailer, message généré en
  mémoire) — c'est comme ça que le déclencheur a été vérifié ici. Sans
  cette variable (Render), c'est le vrai Gmail qui est utilisé.

### Commandes — règles

- Produits au poids : poids choisi par le client de 1 g à 5000 g, prix
  stocké au kg, total estimé sur le poids entier entré.
- Pourboire livreur en livraison seulement (forcé à 0 en cueillette).
- Produits à prix 0 ou indisponibles : non commandables.
- À la collecte : un article manquant tombe à 0 (remplacement éventuel
  enregistré, non facturé) ; le poids réel pesé recalcule la ligne et le
  total ; quand tous les articles sont collectés ou manquants, le total
  devient le total final (`final_total_cents`).

### Taxes TPS / TVQ (règles de Riad, 2026-11-15)

- Prix affichés hors taxes ; taxes calculées côté serveur à la création
  de la commande et ajoutées au total (estimé et final), stockées en
  `tps_cents` et `tvq_cents` sur la commande, recalculées à la collecte
  (un article manquant ou remplacé fait tomber sa taxe).
- TPS 5 % ; TVQ 9,975 % calculée sur (prix + TPS). Arrondi au cent par
  ligne (frais inclus).
- DÉTAXÉS (0 %) : Fruits, Légumes, Viandes et poissons, Laitages et
  œufs, Boulangerie, Épicerie sèche et conserves, Surgelés — ainsi que
  les rayons sans règle propre (Promotions, Bébé et enfant, Santé).
- TAXABLES TPS + TVQ : Boissons, Grignotines, Produits ménagers, Soins
  personnels et beauté, Animaux, Fleurs et plantes, Fête, Jouets et jeux.
- Pâtisserie : moins de 6 pièces du même produit → TPS seulement ;
  6 pièces ou plus → aucune taxe.
- Vendu au poids → aucune taxe, quel que soit le rayon.
- Aliment préparé / fast-food (ex. pizza) → taxable TPS + TVQ :
  indicateur `prepared` sur le produit (colonne `products.prepared`,
  réglable par `POST /api/admin/products`) ; aucun produit concerné
  pour l'instant.
- Frais de livraison et frais de service → taxables TPS + TVQ.

### Photos produits

- `POST /api/admin/upload-photo` (multipart, jeton admin exigé) : champ
  `photo`, types acceptés JPEG / PNG / WebP, 5 Mo maximum. Le fichier est
  stocké sous `data/uploads/` (dans `~/workspace`, il survit donc à un
  remplacement de VM, contrairement à Postgres installé par apt) avec un
  nom unique (`<horodatage>-<aléatoire>.<ext>`, jamais le nom d'origine).
  Réponse : `{ ok: true, image_key, mime_type, size }`. L'`image_key`
  est ensuite à passer à `POST /api/admin/products`.
- `GET /api/images/:key` (lecture publique) : sert le fichier avec le
  bon type MIME, 404 si la clé est inconnue ou la clé invalide (la clé
  est validée pour empêcher toute traversée de chemin).
- `GET /api/catalog` (et les réponses produits de l'admin) renvoient
  désormais un `photo_url` réel (`/api/images/<image_key>`) pour les
  produits qui ont une `image_key`, `null` sinon.
- **Photos migrées (2026-11-15)** : les 18 produits ajoutés le 2026-11-14
  (ids 50–67 : 9 fruits et légumes, 6 viandes et poissons, 3 pâtisseries)
  ont leur photo générée dans `data/uploads/` sous un nom stable
  `<slug>.webp` (ex. `poires.webp`, `merguez.webp`, `trois-chocolats.webp`),
  et leur `image_key` vaut ce nom de fichier. Convention : l'`image_key`
  doit inclure l'extension (`.webp`, `.jpg`, `.png`), sinon
  `GET /api/images/:key` répond 404 (pas de type MIME sans extension).
  L'`image_key` est dans `src/data/catalog.json` comme dans la base, donc
  un réensemencement (`npm run seed`) la conserve. Les 18 restent à prix 0
  et indisponibles (« Prix fixé à l'inventaire du matin »).
- Les 24 premiers produits (ids 1–24) gardent l'`image_key` en forme de
  slug sans extension héritée de l'export de l'appli web : leur `photo_url`
  répond 404 tant que leurs fichiers ne sont pas dans `data/uploads/`.
  **Récupération vérifiée le 2026-11-15 (inspection de l'appli web)** : les
  photos ne sont ni en base ni en blob (`photo_blob_key = null` pour les
  24) — ce sont des assets statiques embarqués au build de l'appli web,
  importés dans `client/src/images.ts` (`PRODUCT_IMAGES`) depuis
  `client/src/assets/` (ex. `tomates.webp`, `bananes.jpg`, `cheddar.png`).
  Aucune action de l'appli ne renvoie d'image (`listcatalog` ne donne que
  la clé, `photo_url` null ; `describeproductphoto` prend une photo en
  entrée ; `upsertproduct` en envoie une) : il n'existe ni téléchargement
  ni export. La seule récupération possible est une copie en lecture seule
  des 24 fichiers sources (`client/src/assets/`, extensions mélangées :
  `.webp`, `.jpg`, `.png` — garder l'extension d'origine dans
  l'`image_key`, le serveur accepte JPEG/PNG/WebP), puis mettre
  `image_key` à `<slug>.<ext>` dans `catalog.json` et réensemencer. Cette
  copie directe des fichiers de l'appli web n'a pas été faite (lecture des
  fichiers de l'artefact interdite) : à autoriser explicitement, ou
  alternative — reprendre les photos via le formulaire admin
  (`POST /api/admin/upload-photo`, qui fonctionne), ou régénérer des
  photos IA dans le même style.
- **Photos des 24 premiers produits — COPIÉES le 2026-11-15** (copie en
  lecture seule autorisée explicitement, aucune écriture côté artefact) :
  les 24 fichiers sources de `client/src/assets/` de l'appli web ont été
  copiés dans `data/uploads/` (md5 vérifiés, octet pour octet), `image_key`
  mis à `<slug>.<ext>` dans `src/data/catalog.json`, base réensemencée
  (`npm run seed`, prix et dispos inchangés — les 24 restent disponibles,
  avec prix). Vérifié par curl : `GET /api/catalog` donne un `photo_url`
  réel pour les 24, et `GET /api/images/<key>` répond 200 avec le bon type
  MIME pour chacun. Bilan photos : 42/67 produits avec photo (24 premiers
  + 18 nouveaux) ; restent sans photo les 25 produits de la partie B
  (ids 25–49, prix 0, à photographier à Épilys).

### Authentification admin

L'appli web n'a pas d'authentification admin : ici, les routes
`/api/admin/*` et `GET /api/orders` exigent le jeton `ADMIN_TOKEN`
(en-tête `Authorization: Bearer <jeton>`). Sans `ADMIN_TOKEN` configuré,
elles répondent 503. Générer le jeton avec :
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Connexion Google / Apple

- Google : l'identifiant et le secret viennent des réglages admin
  (`POST /api/admin/google-settings`) ou, à défaut, de `GOOGLE_CLIENT_ID`
  / `GOOGLE_CLIENT_SECRET`. Le code est échangé côté serveur, le compte
  est retrouvé ou créé par courriel vérifié. Aucun identifiant n'est créé
  par ce serveur.
- Apple : le jeton d'identité est vérifié par la clé publique Apple
  (JWKS) ; l'audience attendue est `APPLE_CLIENT_ID` (identifiant du
  paquet iOS, par exemple `com.soukly.app`). Aucun secret Apple nécessaire.

### Appels sortants

Les appels vers Google, Apple et OpenAI passent par `src/http.js` avec
un délai maximal de 15 s : un amont qui ne répond pas donne une erreur
502 propre au lieu de bloquer la requête.

## Données migrées

`src/data/catalog.json` est l'export fidèle de l'appli web (action
`listcatalog`, 2026-11-14) : **19 rayons, 67 produits** (24 disponibles
avec prix, 43 à prix 0, « Prix fixé à l'inventaire du matin »). Les
identifiants produits d'origine sont conservés pour la traçabilité.
Les commandes passées ne sont pas migrées (restent dans l'appli web).

## Limite connue (bac à sable uniquement)

Dans ce bac à sable, les requêtes **POST vers
`generativelanguage.googleapis.com`** (Gemini) restent sans réponse
(vérifié en curl direct comme via le serveur), alors que les GET vers le
même hôte répondent et que les POST vers `oauth2.googleapis.com` et
`appleid.apple.com` fonctionnent. `POST /api/admin/ai/test-key` et
`POST /api/admin/ai/describe-photo` répondent donc 502 (délai dépassé)
ici, avec une fausse clé comme avec une vraie. Sur le serveur hébergé
(en production, sans proxy de sortie), ces appels fonctionneront
normalement. La logique a été vérifiée par ailleurs : le GET Gemini
renvoie « API key not valid » avec une fausse clé, et la chaîne de
secours des modèles est celle de l'appli web
(`gemini-3.5-flash-lite` → `gemini-3.8-flash` → `gemini-3.5-flash`).

Le mot de passe du proxy de sortie du bac à sable tourne : si les
appels sortants (Google, IA) se mettent à dépasser le délai, redémarrer
le serveur pour qu'il reprenne l'environnement frais.

## Reste à faire (étapes suivantes)

- Appli Flutter (squelette, boutique client, admin) — voir plan §3/§6.
- Choix de l'hébergeur public + Postgres hébergée, puis déploiement.
- Page de politique de confidentialité (obligatoire pour les boutiques).

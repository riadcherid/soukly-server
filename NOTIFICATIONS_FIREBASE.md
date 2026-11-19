# Notifications push FCM — brancher Firebase (v0.7.4)

Le code est prêt (serveur v0.7.4 + appli), mais **rien ne peut encore
sonner** : il manque le projet Firebase. Étapes ci-dessous, dans
l'ordre. Compte Google à utiliser : celui de Riad (le même que le
compte développeur Google Play « Riadcher »).

## 1. Créer le projet Firebase

1. Aller sur https://console.firebase.google.com/ (compte Google de Riad).
2. « Ajouter un projet » → nom **Soukly** → accepter les conditions →
   créer (Google Analytics : laisser activé ou non, sans importance).
3. Noter l'**ID du projet** (ex. `soukly-xxxxx`) : il apparaît dans
   Paramètres du projet → Général. C'est lui que le serveur utilise
   dans l'URL FCM.

## 2. Ajouter l'appli Android

1. Dans le projet Firebase : « Ajouter une appli » → Android.
2. **Nom du package Android : `com.soukly.soukly`** — attention, ce
   n'est PAS `com.soukly` : le vrai `applicationId` est dans
   `app/android/app/build.gradle.kts` (namespace `com.soukly.soukly`).
   Si le package est faux, le jeton FCM ne correspondra à aucune
   appli et rien n'arrivera.
3. Surnom : « Soukly Android ». La signature SHA-1 n'est pas
   obligatoire pour FCM (elle ne sert qu'à la connexion Google).
4. Télécharger **`google-services.json`** et le placer dans
   `app/android/app/google-services.json` (sur cette machine, là où
   l'APK est construite). Ne pas le commiter dans le dépôt git
   (ajouter `app/android/app/google-services.json` au `.gitignore` si
   ce n'est pas déjà fait).
5. **Seulement après avoir placé le fichier**, activer le plugin
   Google Services (sans le fichier, le build échoue avec
   « File google-services.json is missing ») :
   - dans `android/settings.gradle.kts`, bloc `plugins`, ajouter :
     `id("com.google.gms.google-services") version "4.4.2" apply false`
   - dans `android/app/build.gradle.kts`, bloc `plugins`, ajouter :
     `id("com.google.gms.google-services")`
6. Reconstruire l'APK/AAB (le fichier est lu au moment du build).

Variante sans plugin : l'appli accepte aussi les options Firebase en
`--dart-define` au build (`FIREBASE_API_KEY`, `FIREBASE_APP_ID`,
`FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID` — valeurs dans
Paramètres du projet → Général → « Vos applis » → appli Android).
La voie standard (plugin + google-services.json) reste recommandée.

## 3. Clé du compte de service (côté serveur)

La clé sert au serveur pour envoyer les notifications (API FCM HTTP
v1). **Elle contient une clé privée : ne jamais la commiter, ne jamais
la coller dans le chat.**

1. Firebase console → Paramètres du projet → Comptes de service →
   « Générer une nouvelle clé privée » → télécharger le JSON.
2. Dans Render : service `soukly-server` → Environment → ajouter la
   variable **`FIREBASE_SERVICE_ACCOUNT_JSON`** avec **tout le JSON
   en une seule ligne** (sans saut de ligne).
3. Render redéploie automatiquement. Vérifier ensuite :
   - `GET https://soukly-server.onrender.com/api/health` → `0.7.4` ;
   - les journaux Render ne doivent plus afficher
     `[fcm] FIREBASE_SERVICE_ACCOUNT_JSON non défini`.

## 4. Tester de bout en bout

1. Installer la nouvelle APK (construite après l'étape 2) sur le
   téléphone.
2. Se connecter (client) et passer une commande : l'admin (téléphone
   avec le rôle Admin + jeton enregistré) reçoit « Nouvelle commande »
   **avec son**.
3. Vérifier les autres cas : commande assignée → livreur notifié ;
   changement de statut → client notifié ; dépôt avec photo → client
   et admin notifiés. Un tap sur la notification ouvre le suivi / le
   détail de la commande.
4. Si une notification n'arrive pas : vérifier que l'autorisation de
   notification est accordée (Android 13+ : Paramètres → Applis →
   Soukly → Notifications) et que le téléphone n'est pas en mode
   « Ne pas déranger ».

## Notes

- **Son** : les notifications utilisent le son par défaut du
  téléphone et le canal Android « Commandes Soukly » (créé par
  l'appli au démarrage). Le son se change dans Paramètres Android →
  Applis → Soukly → Notifications → Commandes Soukly.
- **iOS (plus tard)** : ajouter l'appli iOS dans le même projet
  Firebase (`GoogleService-Info.plist` dans `ios/Runner/`) et
  configurer APNs (clé APNs dans Cloud Messaging) — hors scope pour
  l'instant, l'appli iOS n'est pas construite.
- **Sans Firebase** (état actuel) : l'appli démarre normalement, les
  déclencheurs serveur sont ignorés proprement (`fcm_not_configured`)
  et aucune action (commande, statut, livraison) n'est bloquée.
- **Confidentialité** : les jetons FCM sont stockés dans la table
  `device_tokens` (un jeton = un destinataire) ; ils sont retirés à
  la déconnexion et transférés au nouveau compte en cas de
  reconnexion sur le même téléphone.

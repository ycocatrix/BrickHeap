# Tester sur iPhone et Android

1. `npm install && cp .env.example .env`, puis renseigner Supabase. Sans clés, l'app tourne en mode « sans compte » :
   tout fonctionne en local et les pièces restent des références provisoires (nom et image Brickognize).
2. Installer **Expo Go** sur les deux téléphones (App Store / Play Store). BrickHeap V1 n'utilise que des modules
   embarqués dans Expo Go SDK 58 : aucun development build n'est nécessaire.
3. `npx expo start` — téléphones sur le **même Wi-Fi** que le Mac.
   - iPhone : scanner le QR code avec l'app Caméra → s'ouvre dans Expo Go.
   - Android : scanner le QR code depuis Expo Go.
   - Réseau d'entreprise/isolé : `npx expo start --tunnel`.
   - Android en USB : activer le débogage USB, `adb devices`, puis `npx expo start --android`.
4. Premier lancement : écran d'accueil → « Continuer sans compte » ouvre le Scanner. Accepter la permission caméra
   (le texte mentionne l'envoi des images à Brickognize) ; la barre d'onglets (Scanner · Inventaire · Listes ·
   Compte) est en bas.
5. Vérifier : encoche / Dynamic Island non masquée (iOS), barre de navigation système non recouverte (Android).

Le protocole complet de recette sur appareil est dans [`DEVICE_TEST_SCRIPT.md`](DEVICE_TEST_SCRIPT.md).

## Backend (optionnel, pour les comptes, la synchronisation et la fiche pièce)

1. Créer un projet Supabase gratuit, puis `npx supabase link`.
2. Dans `.env` : `EXPO_PUBLIC_SUPABASE_URL` et la clé **publishable** `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   (Project Settings > API keys > publishable « default »). L'ancienne clé `anon` est lue en repli mais
   `catalog-proxy` la refuse.
3. Appliquer les migrations : `npx supabase db push` (la CLI v3 vise la pile locale par défaut : vérifier la cible,
   ajouter `--remote` si besoin).
4. Déployer les fonctions : `npx supabase secrets set REBRICKABLE_API_KEY=…`, puis
   `npx supabase functions deploy catalog-proxy delete-account --use-api`, puis
   `supabase/functions/catalog-proxy/smoke.sh`.
5. Configuration Auth : `npx supabase config diff`, puis `npx supabase config push` (ou dans le tableau de bord :
   code OTP à 6 chiffres, URL de redirection `brickheap://**` et `exp://**`, les trois modèles d'e-mail avec
   `{{ .Token }}`).
6. **E-mails** : le SMTP intégré de Supabase n'envoie qu'aux adresses de l'équipe du projet (2 e-mails/heure).
   Pour d'autres destinataires, configurer un fournisseur SMTP (offre gratuite) dans les réglages Auth.

Aucune URL de détecteur n'est à configurer : la segmentation de la pile se fait sur l'appareil.

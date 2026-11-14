# Contribuer à BrickHeap

Merci de votre intérêt ! BrickHeap est un projet communautaire : <https://github.com/ycocatrix/BrickHeap>.

## Démarrage

```bash
git clone https://github.com/ycocatrix/BrickHeap.git && cd BrickHeap
npm install
cp .env.example .env      # puis renseignez vos propres clés (jamais commitées)
npx expo start
```

Avant toute PR : `npm run check` (`tsc --noEmit`, `jest`, `expo lint`). L'app tourne dans **Expo Go** (SDK 58) :
n'ajoutez pas de dépendance native absente d'Expo Go, et installez avec `npx expo install` (voir `AGENTS.md`).

## Structure du code

```
src/app/               routes Expo Router (fichiers d'une à trois lignes qui réexportent un écran)
src/screens/           écrans, par zone (scanner, inventory, lists, part, auth, account, settings, sync…)
src/components/        kit UI (Screen, Button, ConfidenceBadge, QuantityStepper, feuilles basses…)
src/domain/            logique pure testable avec Jest, sans import React Native
src/domain/vision/     segmentation de la pile, couleurs (Lab, CIEDE2000), suivi des boîtes
src/domain/pile/       seuils de confiance, regroupement PartID+ColorID, validation, calibration
src/services/          Brickognize, imagerie, catalogue, Supabase, sync, export
src/data/              SQLite local (schéma, file d'écriture unique `withWrite`, dépôts)
src/state/             petits stores (session, réglages, scan, sync)
src/i18n/fr/           textes français : un module par zone (common, ui, scan, inventory…)
supabase/migrations/   SQL versionné (une migration = un fichier horodaté)
supabase/functions/    Edge Functions (catalog-proxy, delete-account) — Deno, hors `tsc`
supabase/tests/        tests SQL (`bash supabase/tests/run.sh`)
docs/                  specs, architecture, maquettes, plan d'implémentation, tests sur appareil
```

- La logique métier va dans `src/domain/` (pure, sans React) pour rester testable avec Jest.
- Aucun texte français en dur dans les écrans ou composants : **un module de textes par zone** dans `src/i18n/fr/`.
- Accessibilité : chaque élément touchable fait au moins 48 dp et porte un rôle et un libellé français ; un statut
  n'est jamais indiqué par la seule couleur (icône + texte + couleur).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) : `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
Ex. : `feat(scanner): regroupe les détections par PartID+ColorID`.

## Issues et Pull Requests

- Une issue par bug/idée ; pour un bug de détection, joignez photo, appareil/OS et résultat attendu.
- Une PR = un sujet, branche `feat/...` ou `fix/...`, description de ce qui change et comment tester.
- Toute nouvelle fonctionnalité utilisateur doit être décrite dans `docs/FUNCTIONAL_SPECS.md`.
- Ne commitez **jamais** de clé API. Un secret commité doit être révoqué immédiatement.
- Ne copiez pas d'images/données sous licence incompatible ; respectez les CGU de Rebrickable et Brickognize.

## Améliorer la détection de piles

1. Activez le **Mode Calibration** (Réglages), scannez la scène en échec en mode Inventorier, saisissez la liste
   attendue (`PartID/ColorID xQuantité`) et enregistrez la session (JSON sans image ni donnée personnelle).
2. Joignez ce JSON et la vérité terrain à l'issue.
3. Pistes : courbe de confiance et seuils (`src/domain/pile/thresholds.ts`), réglages de segmentation
   (`SEGMENT_DEFAULTS` dans `src/domain/vision/segment.ts`, constantes de `src/domain/vision/config.ts`), NMS / pièces collées, taille des crops envoyés à
   Brickognize.
4. Tout ajustement s'accompagne d'un cas de test Jest de non-régression (`src/domain/pile/__tests__/` ou
   `src/domain/vision/__tests__/`).
5. Le protocole de mesure sur appareil est dans [`docs/DEVICE_TEST_SCRIPT.md`](docs/DEVICE_TEST_SCRIPT.md).

## Code de conduite

Soyez bienveillant et constructif. Les comportements irrespectueux ne sont pas tolérés.

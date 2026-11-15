# Script de test sur appareil — BrickHeap V1

Source : [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §7.4 (révision 2). Ce script est la recette finale après
la porte d'intégration (§5.10) ; ses mesures de la section I décident du réglage des seuils (risque R2, §8.1).

## Préparation

- **Appareils** : un iPhone et un téléphone Android, dans **Expo Go**, sur le même Wi-Fi que le Mac
  (`npx expo start`, `--tunnel` si besoin). Si possible, refaire I2 sur le téléphone Android le plus lent disponible.
- **Matériel** : environ 30 vraies briques dont **20 pièces simples et propres** (briques, plaques, tuiles, pentes dans
  des couleurs courantes : rouge, bleu, jaune, blanc, noir, gris bleuté clair), une pièce transparente, une pièce
  imprimée, deux pièces de même couleur ; une table claire unie, une surface sombre unie, une surface à motifs
  (nappe) ; lumière du jour et lumière intérieure.
- **Avant de commencer** : écrire la liste attendue de la pile de 20 pièces (`PartID/ColorID xQté`, ids trouvés sur
  rebrickable.com).
- **Sections E, G, H** : nécessitent les actions utilisateur U1–U5 (plan §8.3). Sans elles, vérifier les états
  dégradés décrits.
- Noter **chaque chiffre demandé, par appareil**, dans le tableau en fin de document.

## A. Démarrage et permission (sans backend)

1. Démarrage à froid → écran d'accueil ; « Continuer sans compte » → onglet Scanner. Tuer l'app et relancer →
   Scanner directement.
2. Le texte de la feuille de permission mentionne Brickognize ; « Plus tard » laisse une app utilisable ;
   « Autoriser » affiche la caméra. Refus au niveau système → « Ouvrir les réglages » ouvre les réglages du système.
3. Temps entre le toucher de l'app dans Expo Go et l'aperçu caméra au relancement : **< 3 s**. L'encoche /
   Dynamic Island et la barre de navigation Android ne recouvrent aucune commande.

## B. Explorer (direct)

1. Cinq pièces espacées sur la table claire : des cadres apparaissent en ≈ 5 s sans rien toucher. Noter la période
   de rafraîchissement des cadres, et si l'aperçu se fige ou si un bruit d'obturateur est émis à chaque instantané.
2. **Alignement** : les cadres sont sur les pièces dans l'aperçu (erreur < 5 % de la largeur de l'écran). Sur
   Android, vérifier particulièrement le haut et le bas de l'aperçu. En cas de décalage, noter l'appareil et les
   tailles photo/aperçu.
   **Cas de rotation Android** : incliner le téléphone en paysage 2 s, puis le poser à plat au-dessus de la pile :
   les cadres sont soit alignés, soit non dessinés (jamais dessinés tournés) ; l'indication « Tenez le téléphone en
   portrait » apparaît. Noter si l'image figée après un toucher est affichée tournée (limite connue R3).
   - 2bis. Noter la période de rafraîchissement en direct sur le téléphone le plus lent, et si le glissement du
     tiroir reste fluide pendant le traitement d'un instantané.
3. Tenir immobile 10 s : aucune nouvelle identification (les cadres ne repassent pas au gris). Passer à une autre
   pile : les anciens cadres disparaissent, les nouveaux sont identifiés.
4. Toucher un cadre → la vue se fige sur cet instantané → la fiche s'ouvre ; retour → « Reprendre » revient au
   direct. Rien n'apparaît dans Inventaire. Toucher un cadre tout juste apparu (vu une seule fois) : il est
   identifié, jamais bloqué sur un indicateur de chargement.
5. Tiroir : l'en-tête affiche « ≈ N pièces détectées » ; glisser et toucher changent tous deux sa hauteur ; toucher
   une ligne surligne les cadres et ouvre la fiche ; un badge orange ouvre le choix des candidats avec la photo de la
   pièce en haut. Le retour Android replie le tiroir, puis reprend une vue figée.
6. Basculer Explorer ↔ Inventorier cinq fois : l'aperçu ne devient jamais noir.
7. Réglages → « Explorer en direct » désactivé → un bouton « Analyser » remplace le scan automatique.

## C. Inventorier (pile)

1. La pile de 20 pièces, espacées, table claire, lumière du jour : déclencheur → cadres en ≈ 2 s, toutes identifiées
   en ≈ 8 s en Wi-Fi. Noter : cadres trouvés / 20, pièces avec la bonne référence, avec la bonne couleur, nombre par
   statut (vert / orange / gris), temps total.
2. « Valider » → lignes groupées (`3× Brique 2 × 4 …`, libellés français), bandeau « ≈ », `+ / −` et quantité
   saisie, changement de couleur (suggestions d'abord, photo de la pièce et couleur mesurée en haut), suppression,
   « Inconnue » → choix parmi les candidats (la ligne montre la photo de la pièce réelle), « Pièce coupée » pour une
   pièce coupée par le bord, badge orange → choix appliqué à toute la ligne. Le pied de page affiche « dont N à
   vérifier » et le nombre de pièces qui seront ignorées.
3. Une ligne « Couleur à confirmer » désactive « Ajouter » avec une explication ; « Confirmer {couleur} » (un
   toucher) ou « Tout confirmer » réactive le bouton.
4. « Ajouter N pièces à Mon inventaire » → confirmation visuelle, snackbar avec « Annuler » pendant 10 s (« N ajoutées
   · K ignorées » si certaines ont été écartées) ; l'annulation retire exactement ce qui a été ajouté. Ajouter de
   nouveau, rescanner la même pile → avertissement « Déjà ajouté depuis cette session ».
   - 4bis. Toucher « Reprendre » pendant une longue analyse (40 pièces, réseau lent) : le scanner revient
     immédiatement au direct et aucun résultat tardif n'apparaît.
5. Refaire 1 sur la surface sombre, en intérieur, et avec des pièces qui se touchent : noter la dégradation (attendu :
   des pièces de même couleur qui se touchent fusionnent → « plusieurs pièces ? », corrigé avec `+ / −`).
6. Même pile, second angle de vue : les comptes diffèrent légèrement → le « ≈ » est justifié.

## D. Ergonomie caméra et pannes

1. La torche s'allume et s'éteint ; un appui long verrouille la mise au point (l'icône change) ; sur Android, noter
   si le verrouillage a un effet.
2. Surface à motifs → bandeau de conseil, pas d'avalanche de cadres ; une pièce seule est quand même identifiée.
3. Mode avion → déclencheur : les cadres apparaissent en gris avec « Identification indisponible » ; de retour en
   ligne → « Réessayer » les identifie. L'app ne se fige ni ne plante jamais.
4. Pile d'environ 40 petites pièces : l'app reste réactive ; noter le temps de segmentation et les éventuels
   avertissements mémoire.
5. Quitter l'onglet Scanner et y revenir 10 fois ; verrouiller/déverrouiller le téléphone : l'aperçu revient à chaque
   fois.

## E. Fiche pièce (nécessite `catalog-proxy` déployé ; sinon vérifier les états dégradés)

1. Bloc d'identité : nom officiel, Design ID, Element ID, nom de couleur + hex, catégorie, dimensions (« — » pour une
   goupille Technic).
2. « Rechercher sur Pick a Brick » ouvre le navigateur sur Pick a Brick avec une requête ; noter si des résultats
   s'affichent pour l'Element ID.
3. La liste des sets défile, « Charger plus » fonctionne, les filtres année et nom fonctionnent, toucher un set
   affiche « ×N ».
4. Proxy injoignable (mode avion après un premier chargement) : l'identité en cache reste affichée, les sets montrent
   une erreur + « Réessayer ».
5. Une pièce dont l'id Brickognize diffère de Rebrickable (ex. brique ronde 1 × 1 → `3062b`, plaque ronde 1 × 1 →
   `6141`) affiche l'id Rebrickable une fois résolue (nom provisoire d'abord, puis remplacé).
6. « + Ajouter à une liste » → la feuille des listes se ferme, puis le snackbar d'annulation est visible 10 s ;
   l'écran a un chevron retour et pas de barre d'onglets.

## F. Inventaire, listes, export (mode avion, sans compte)

1. Grille : vignettes image, badge jaune de quantité en haut à droite de l'image, `99+` au-delà de 99 (saisir 120
   dans le sélecteur de quantité). **La couleur de la vignette correspond à la brique** (après hydratation en ligne)
   ou, hors ligne / avant hydratation, la vignette porte une pastille qui nomme la vraie couleur.
2. Vue liste, regroupement par catégorie / couleur / liste (titres de catégorie en français), recherche « brique »,
   « plaque », avec et sans accents, filtres couleur et catégorie ; une recherche sans résultat affiche « Aucun
   résultat » + « Effacer les filtres ».
3. Modifier une quantité ; la passer à 0 → la feuille d'actions se ferme et le snackbar d'annulation est visible,
   « Annuler » la restaure ; déplacer vers une autre liste ; « Supprimer » → la feuille se ferme, snackbar visible,
   l'annulation fonctionne.
4. Listes : créer (nom en double refusé avec un message), renommer, supprimer avec confirmation ; la dernière liste
   ne peut pas être supprimée.
5. Export CSV, JSON et BrickLink XML → la feuille de partage s'ouvre avec un fichier correctement nommé ; de retour
   dans l'app, le résultat (« N lignes exportées », nombre ignoré pour le XML) s'affiche dans la feuille d'export ;
   ouvrir le CSV dans un tableur (accents intacts), valider le XML sur la page d'import de wanted list BrickLink (sans
   soumettre).
6. Installation neuve en mode sans compte → Listes affiche « Mon inventaire ».

## G. Compte (après les actions utilisateur du plan §8.3 ; utiliser une adresse de l'équipe tant que le SMTP n'est pas configuré)

1. Inscription avec un e-mail invalide et un mot de passe de 7 caractères → erreurs de champ. Inscription valide →
   écran de code → le code reçu par e-mail connecte. Essayer aussi « J'ai confirmé via le lien ».
2. Déconnexion (avec une modification en attente → avertissement), connexion par mot de passe ; mauvais mot de passe
   → message clair + issues.
3. « Recevoir un code de connexion » → code → connecté.
4. Mot de passe oublié avec une adresse existante et une adresse inexistante → message identique ; code → nouveau mot
   de passe → connecté.
5. Tuer l'app, relancer → toujours connecté. La laisser plus d'1 h en arrière-plan → toujours connecté au retour.
   **Démarrage à froid hors ligne** : connecté, mode avion, avancer l'horloge de 2 h (ou attendre plus d'1 h),
   démarrage à froid → caméra en < 3 s, toujours connecté, pas de bandeau « Session expirée », la sync affiche
   « Hors ligne » ; de retour en ligne → synchronise.
6. Changer le mot de passe, modifier le pseudo (avec un accent : « Élodie » ; relancer → pseudo intact). Supprimer le
   compte (taper SUPPRIMER ; la feuille mentionne les données de cet appareil et propose « Exporter d'abord ») →
   retour à l'accueil ; se reconnecter échoue.
7. Inscription avec un e-mail déjà inscrit → l'écran de code propose « Déjà un compte ? Se connecter ».

## H. Synchronisation et fusion (deux appareils, ou un appareil + réinstallation)

1. L'appareil A connecté ajoute 3 × une pièce ; l'appareil B (même compte) l'affiche après retour au premier plan.
2. Les deux en mode avion : A +3, B +2 sur la même référence ; de retour en ligne → les deux affichent la **somme**.
3. A supprime une référence pendant que B en ajoute 1 hors ligne → après sync, les deux affichent 1.
4. Un invité avec un inventaire local se connecte à un compte qui a déjà des données → question ; « Fusionner »
   additionne les quantités ; refaire avec « Garder uniquement mon compte » et « Annuler ».
5. Compte affiche « synchronisé il y a … », puis « Hors ligne — N modification(s) en attente » en mode avion.
6. Installation neuve sur l'appareil B, connexion directe (sans données invité) → exactement une « Mon inventaire »
   sur les deux appareils après sync (pas de doublon).
7. Se déconnecter pendant une sync (basculer le mode avion pendant la sync) : après reconnexion, les quantités ne sont
   pas doublées.
8. Connecté en tant que B sur un appareil qui contient les données de A → question ; « Conserver ces données (mode
   sans compte) » les garde comme données invité.
9. `catalog-proxy` injoignable, ajouter une pièce scannée en étant connecté : Compte affiche « 1 pièce en attente
   d'identification catalogue » ; quand le proxy répond, elle se synchronise sous son id Rebrickable et l'appareil B
   affiche la même quantité (non doublée).

## I. Calibration et mesures de performance

1. Activer le Mode Calibration, scanner la pile de 20 pièces, saisir la liste attendue, « Comparer » : noter
   précision, rappel (objectif **≥ 0,80**), précision/rappel « pièce seule », écart de comptage ; enregistrer et
   partager le JSON vers soi-même.
2. Depuis le JSON de la session, noter `prepareMs`, `segmentMs`, `identifyMs`, `catalogMs`, `brickognizeCalls`, y
   compris sur **le téléphone Android le plus lent disponible**.
   **Règle go/no-go (R2)** : `segmentMs` du chemin de capture ≤ 1500 ms et rafraîchissement en direct ≤ 6 s → on livre
   tel quel ; sinon `liveExplorer` passe à `false` par défaut (`DEFAULT_SETTINGS`) et `segMaxSide.inventory`
   descend à 256.
3. Comparer la part de pièces correctes parmi les cadres verts (≥ 80 %) et orange : si le vert se trompe plus d'une
   fois sur 5, ou si la plupart des pièces correctes sont orange, `SCORE_CALIBRATION` doit être ajusté.

## J. Accessibilité (VoiceOver et TalkBack)

1. Chaque commande du Scanner, de la Validation, de l'Inventaire, des Listes, du Compte et des écrans
   d'authentification est atteignable et annoncée en français avec son rôle ; les cadres annoncent nom, couleur,
   pourcentage et statut.
2. Police système à la plus grande taille hors accessibilité : aucun texte coupé ; toutes les cibles restent
   touchables (au moins 48 dp).
3. Mode niveaux de gris : les trois niveaux de confiance restent distinguables (icône ✓ / ? / –, texte, forme du
   badge).

## Relevé des mesures

| Mesure | iPhone | Android | Android le plus lent |
|---|---|---|---|
| Modèle / OS | | | |
| A3 — temps jusqu'à l'aperçu au relancement (s) | | | |
| B1 — période de rafraîchissement des cadres (s) ; aperçu figé ? obturateur ? | | | |
| B2 — alignement (erreur, % largeur) ; cas rotation | | | |
| B2bis — période en direct ; tiroir fluide ? | | | |
| C1 — cadres trouvés / 20 | | | |
| C1 — bonne référence / bonne couleur | | | |
| C1 — vert / orange / gris | | | |
| C1 — temps total (s) | | | |
| C5 — dégradation (sombre, intérieur, pièces collées) | | | |
| D4 — temps de segmentation, alertes mémoire (40 pièces) | | | |
| I1 — précision / rappel / pièce seule / écart de comptage | | | |
| I2 — prepareMs / segmentMs / identifyMs / catalogMs / appels Brickognize | | | |
| I3 — vert faux (sur 5) ; part des correctes en orange | | | |
| Décision R2 (go / no-go) | | | |

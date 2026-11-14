// French messages produced by WP3 (pile logic and scan services, §4.5). WP4 displays them.
export const scan = {
  /** Crop source rectangle below VISION.crop.minSourceSide (Identification.error === 'invalid'). */
  tooSmall: 'Pièce trop petite — rapprochez-vous',
  /** Short box label for a piece too small to identify. */
  tooSmallShort: 'trop petite — rapprochez-vous',
  noCrop: 'Impossible de découper cette pièce dans la photo.',
  prepareFailed: 'La photo n’a pas pu être préparée. Reprenez la photo.',
  thumbnailFailed: 'La photo n’a pas pu être lue. Reprenez la photo.',
  segmentFailed: 'L’analyse de la photo a échoué. Reprenez la photo.',
  cancelled: 'Analyse annulée.',
  liveUnavailable: 'Mode direct indisponible sur cet appareil',
  identificationUnavailable: 'Identification indisponible',
  patternedBackground: 'Étalez les pièces sur une surface unie, sans qu’elles se touchent.',
  noPiece: 'Pointez la caméra vers vos briques',
  tooMany: 'Trop de pièces : étalez-en moins à la fois',
  noReview: 'Aucune pile à valider. Reprenez le scan.',
  nothingToAdd: 'Aucune pièce à ajouter.',
  colorToConfirm: 'Confirmez d’abord les couleurs à vérifier.',
  addFailed: 'Les pièces n’ont pas pu être ajoutées. Réessayez.',
  undoFailed: 'L’annulation a échoué. Réessayez.',
} as const;

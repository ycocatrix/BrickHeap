// Shared contracts. Types only: no imports, no runtime code.

// ---------- primitives ----------
/** Catalogue part id. A Rebrickable `part_num` when the part's `source` is 'rebrickable';
 *  otherwise the BrickLink-flavoured id returned by Brickognize (provisional part, decision D7). */
export type PartId = string;
/** Item id as returned by Brickognize (BrickLink-flavoured, mould letters sometimes stripped). */
export type BricklinkId = string;
/** Rebrickable colour id. */
export type ColorId = number;
/** UUID v4 generated on the device (expo-crypto `randomUUID`). */
export type ListId = string;
export type DetectionId = string;
export type Lab = readonly [L: number, a: number, b: number];
export type Rgb = readonly [r: number, g: number, b: number];

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
/** Normalised 0..1, origin top-left, relative to the analysed image. */
export interface BoundingBox { x: number; y: number; w: number; h: number }
/** Pixel rectangle in the shape expected by expo-image-manipulator `crop()`. */
export interface PixelRect { originX: number; originY: number; width: number; height: number }

// ---------- errors ----------
export type AppErrorCode =
  | 'offline'          // request failed before any HTTP status (no network, DNS, TLS, paused project)
  | 'timeout'
  | 'rate_limited'     // HTTP 429 after retries
  | 'server'           // HTTP 5xx or malformed response
  | 'not_configured'   // Supabase env vars missing
  | 'unauthorized'     // HTTP 401/403, expired session
  | 'invalid'          // validation error; `message` says what to fix
  | 'not_found'
  | 'unknown';
export interface AppError { code: AppErrorCode; /** French, user-facing. */ message: string; cause?: unknown }
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

// ---------- segmentation (WP2) ----------
export type BackgroundQuality = 'plain' | 'textured' | 'patterned';
export interface SegBox {
  /** Padded box (8 % of the longer side), clamped to the image. Use for cropping and display. */
  box: BoundingBox;
  /** Tight box around the mask. Use for IoU. */
  tight: BoundingBox;
  /** Mask area / image area. */
  areaFrac: number;
  /** The mask touches the image border: the piece is cut by the frame (RG_03 "partielle"). */
  partial: boolean;
  fromSplit: boolean;
  /** Area > 3× the median piece area: probably several pieces merged. */
  suspectMerged: boolean;
  /** Dominant colour of the mask (shadows and glare rejected). */
  lab: Lab;
  rgb: Rgb;
}
export interface SegmentationResult {
  boxes: SegBox[];                                   // sorted top-to-bottom, then left-to-right
  background: { quality: BackgroundQuality; sigmaL: number; sigmaC: number };
  width: number;
  height: number;
  ms: number;
}

// ---------- detection & identification (WP2, WP3) ----------
/** RG_04. 'accepted' ≥ 80 %, 'review' 50–79 %, 'unknown' < 50 % of the calibrated confidence. */
export type ConfidenceLevel = 'accepted' | 'review' | 'unknown';
/** pending: queued or in flight · identified: ≥ 1 candidate · empty: Brickognize found nothing ·
 *  unavailable: network/429/5xx after retries (EX_09, retryable). */
export type IdentificationStatus = 'pending' | 'identified' | 'empty' | 'unavailable';

export interface Detection {
  /** Stable across live snapshots (track id, RG_02). */
  id: DetectionId;
  box: BoundingBox;
  partial: boolean;
  suspectMerged: boolean;
  source: 'segmentation' | 'whole_image' | 'manual';
  /** Local dominant colour; null for manual and whole-image boxes. */
  lab: Lab | null;
  rgb: Rgb | null;
}

export interface Candidate {
  bricklinkId: BricklinkId;
  /** Name as returned by Brickognize (English). */
  name: string;
  imageUrl: string | null;
  category: string | null;
  /** Brickognize similarity 0..1. */
  rawScore: number;
  /** calibrateScore(rawScore), 0..1. */
  confidence: number;
}
export interface ColorCandidate { bricklinkColorId: number; name: string; score: number }

export interface Identification {
  status: IdentificationStatus;
  /** Best first, pseudo-items removed, at most 3. */
  candidates: Candidate[];
  colors: ColorCandidate[];
  /** Brickognize `bounding_box.score` for the crop (0 when nothing found). */
  boxScore: number;
  error: AppErrorCode | null;
}

export interface ColorEstimate {
  colorId: ColorId | null;
  /** false → « couleur à confirmer » (RG_06). */
  reliable: boolean;
  source: 'brickognize' | 'local' | 'user' | 'none';
  /** Other plausible colours, best first, for the picker. */
  alternatives: ColorId[];
}

export interface IdentifiedPiece {
  detection: Detection;
  identification: Identification;
  /** Index of the selected candidate in `identification.candidates`; -1 when none. */
  chosen: number;
  /** Catalogue part of the chosen candidate (resolved or provisional); null until mapped or when chosen = -1. */
  part: CatalogPart | null;
  color: ColorEstimate;
  /** 0..1 calibrated; 1 when `partConfirmed`. */
  confidence: number;
  level: ConfidenceLevel;
  /** The user explicitly picked the candidate. */
  partConfirmed: boolean;
  /** The user confirmed a piece cut by the frame (RG_03). */
  partialConfirmed: boolean;
  /** Local JPEG crop sent to Brickognize (what the user compares against when deciding); null while no crop
   *  exists. Kept until scanActions.resume() / track removal, then deleted. */
  cropUri: string | null;
}

// ---------- grouping & review (WP3) ----------
/** ok: counted (RG_05) · color_to_confirm: RG_06 · partial: RG_03, excluded until confirmed ·
 *  unknown: RG_04 < 50 %, pending, empty or unavailable — never added without an explicit choice.
 *  A provisional part (source 'brickognize') is a known part for grouping purposes. */
export type GroupKind = 'ok' | 'color_to_confirm' | 'partial' | 'unknown';
export interface PileGroup {
  /** 'p:<partId>|<colorId>' · 'c:<partId>|<colorId or ?>' · 'x:<detectionId>' · 'u:<detectionId>'. */
  key: string;
  kind: GroupKind;
  partId: PartId | null;
  colorId: ColorId | null;
  /** Part name (catalogue name, else Brickognize name); '' when unknown. */
  name: string;
  imageUrl: string | null;
  detectionIds: DetectionId[];
  /** Number of boxes in the group. */
  count: number;
  /** Minimum confidence over the members. */
  confidence: number;
  level: ConfidenceLevel;
  /** The part is not (yet) a Rebrickable part (D7). */
  provisional: boolean;
  /** cropUri of the first member that has one: the photo of the real piece (row thumbnail for unknown /
   *  partial / color_to_confirm lines, top of CandidateChooser and ColorPickerSheet). */
  cropUri: string | null;
}
export interface ReviewState {
  pieces: IdentifiedPiece[];
  /** User-edited quantity per group key; absent = group count. */
  quantities: Record<string, number>;
  /** Group keys removed by the user. */
  removed: string[];
}
export interface ReviewLine extends PileGroup {
  /** Effective quantity (override or count). */
  quantity: number;
  /** kind === 'ok' && quantity > 0. */
  addable: boolean;
  /** Quantity of this key already added during this app session (RG_09); 0 if none. */
  alreadyAdded: number;
}
export interface ReviewSummary {
  /** Addable lines / pieces. */
  lines: number;
  pieces: number;
  /** Addable pieces whose level is 'review' and not partConfirmed (« dont {n} à vérifier »). */
  toVerify: number;
  colorToConfirm: number;   // pieces in color_to_confirm lines (blocks the add, RG_06)
  unknown: number;          // pieces that will not be added
  partial: number;          // unconfirmed partial pieces, will not be added
  canAdd: boolean;          // pieces > 0 && colorToConfirm === 0
}

// ---------- scan session (WP3, WP4) ----------
export type ScanMode = 'explore' | 'inventory';
/** Image the boxes refer to, orientation already applied: the camera photo itself (live snapshots, and captures
 *  whose long side ≤ VISION.workMaxSide) or a re-encoded work image. Also the shape of a takePictureAsync result. */
export interface ScanFrame { uri: string; width: number; height: number }
export interface ScanTimings {
  prepareMs: number; segmentMs: number; identifyMs: number; catalogMs: number; totalMs: number;
  brickognizeCalls: number;
}
export type ScanNotice =
  | 'patterned_background'        // « Étalez les pièces sur une surface unie… »
  | 'no_piece'                    // « Pointez la caméra vers vos briques »
  | 'too_many'                    // more than VISION.maxBoxes boxes
  | 'identification_unavailable'  // EX_09
  | 'live_unavailable';           // live loop switched to manual
export interface ScanResult {
  id: string;
  mode: ScanMode;
  frame: ScanFrame;
  background: BackgroundQuality;
  /** true when the whole photo was sent as a single piece. */
  wholeImage: boolean;
  pieces: IdentifiedPiece[];
  timings: ScanTimings;
}

// ---------- catalogue (WP5) ----------
export interface CatalogPart {
  partId: PartId;
  name: string;
  categoryId: number | null;
  imageUrl: string | null;
  bricklinkIds: BricklinkId[];
  /** LEGO design ids (Rebrickable `external_ids.LEGO`). */
  legoIds: string[];
  printOf: PartId | null;
  yearFrom: number | null;
  yearTo: number | null;
  /** 'brickognize' = provisional: only id, name and image are known. */
  source: 'rebrickable' | 'brickognize';
  /** 'resolved' iff source 'rebrickable'. 'pending': mapping not answered yet (proxy unreachable / 'pending');
   *  items of a pending part are never pushed (D7). 'not_found': the proxy explicitly found no Rebrickable part;
   *  the id is then final and synced as is. */
  resolution: 'resolved' | 'pending' | 'not_found';
}
export interface CatalogColor {
  colorId: ColorId;
  /** Rebrickable name (English). French label: `colorLabel()` in src/i18n/fr/colors.ts. */
  name: string;
  /** 6 hex digits, upper case, no '#'. */
  hex: string;
  isTrans: boolean;
  bricklinkId: number | null;
}
export interface CatalogCategory { id: number; name: string }
export interface Palette {
  colors: CatalogColor[];
  categories: CatalogCategory[];
  byId: ReadonlyMap<ColorId, CatalogColor>;
  byBricklinkId: ReadonlyMap<number, CatalogColor>;
  categoryName: ReadonlyMap<number, string>;
}
export interface PartColorInfo {
  partId: PartId;
  colorId: ColorId;
  /** false: Rebrickable does not list this part in this colour. */
  found: boolean;
  /** LEGO element ids for this part+colour (EX_12); last = most recent (assumption). */
  elementIds: string[];
  imageUrl: string | null;
  numSets: number;
}
export interface SetRef {
  setNum: string;
  name: string;
  year: number;
  numParts: number;
  imageUrl: string | null;
}
export interface SetsPage { total: number; page: number; pageSize: number; sets: SetRef[] }
export interface PartDetail { partColor: PartColorInfo; sets: SetsPage | null; stale: boolean }
export interface PartDimensions {
  /** e.g. '2 × 4' or '1 × 1 × 2/3'. */
  label: string;
  studsX: string;
  studsY: string;
  height: string | null;
}

// ---------- inventory (WP6) ----------
export interface List { id: ListId; name: string; createdAt: string }
export interface ListSummary extends List { refCount: number; pieceCount: number }
export interface ItemRef { listId: ListId; partId: PartId; colorId: ColorId }
export interface InventoryItem extends ItemRef { quantity: number; updatedAt: string }
/** Item joined with the local catalogue cache; catalogue fields are null until hydrated. */
export interface InventoryRow extends InventoryItem {
  listName: string;
  part: CatalogPart | null;
  color: CatalogColor | null;
  /** Coloured image when known (part_colors cache), else the generic part image. */
  imageUrl: string | null;
  /** true when imageUrl is the part+colour image; false → the tile draws a colour cue (PartImage.colorCue). */
  coloredImage: boolean;
  /** French category label (categoryLabel), else the Rebrickable name. */
  categoryName: string | null;
}
export interface ItemDelta extends ItemRef { delta: number }
export interface AppliedDeltas { applied: ItemDelta[]; /** Apply these to undo. */ inverse: ItemDelta[] }
export type InventoryGroupBy = 'none' | 'category' | 'color' | 'list';
export interface InventoryFilter {
  listId: ListId | null;            // null = all lists
  query: string;
  colorIds: ColorId[];
  categoryIds: number[];
  groupBy: InventoryGroupBy;
}
export interface InventorySection { key: string; title: string; rows: InventoryRow[] }
export type ExportFormat = 'csv' | 'json' | 'bricklink_xml';

// ---------- sync (WP8) ----------
export interface SyncListWire { id: ListId; name: string; created_at: string; deleted: boolean }
export interface SyncItemDeltaWire { list_id: ListId; part_id: PartId; color_id: ColorId; delta: number }
export interface SyncItemWire { list_id: ListId; part_id: PartId; color_id: ColorId; quantity: number }
export interface SyncBatch { batchId: string; lists: SyncListWire[]; items: SyncItemDeltaWire[] }
/** `server_time` is the raw Postgres timestamptz text (microseconds + offset); stored verbatim in meta.since and
 *  sent back verbatim as p_since — never re-formatted through Date. */
export interface SyncResponse { server_time: string; lists: SyncListWire[]; items: SyncItemWire[] }
export type SyncState =
  | 'disabled'          // guest or Supabase not configured
  | 'idle'
  | 'syncing'
  | 'offline'           // last attempt failed on the network (incl. a retryable token refresh); will retry
  | 'error'
  | 'needs_login'       // local data belongs to an account that was signed out by auth-js (RG_12)
  | 'merge_pending'     // waiting for the user's answer to the guest-merge prompt (RG_11)
  | 'account_mismatch'; // signed in as another user than meta.owner_uid; GuestMergeHost asks what to do
export interface SyncStatus {
  state: SyncState;
  lastSyncAt: string | null;
  /** Local changes not yet pushed (dirty lists + items with quantity ≠ base_quantity), incl. awaitingCatalog. */
  pending: number;
  /** Of `pending`: items held back because their part is a 'pending' provisional part (D7). */
  awaitingCatalog: number;
  error: AppError | null;
}

// ---------- settings & session (WP0) ----------
export interface Settings {
  torchOnLaunch: boolean;      // default false
  haptics: boolean;            // default true
  liveExplorer: boolean;       // default true (D9)
  calibration: boolean;        // default false (EX_10)
  inventoryView: 'grid' | 'list';
}
export interface SessionUser { id: string; email: string; pseudo: string | null }

// ---------- calibration (WP3 domain, WP7 screen) ----------
export interface CountedLine { partId: PartId; colorId: ColorId | null; quantity: number }
export interface CalibrationRow { partId: PartId; colorId: ColorId | null; expected: number; detected: number }
export interface CalibrationMetrics {
  /** On PartID+ColorID keys. tp = Σ min(detected, expected). */
  precision: number;
  recall: number;
  /** Same, ignoring colour (isolates colour errors). */
  partPrecision: number;
  partRecall: number;
  countExpected: number;
  countDetected: number;
  /** countDetected − countExpected (signed). */
  countError: number;
  tp: number; fp: number; fn: number;
  rows: CalibrationRow[];
}
export interface CalibrationDetection {
  box: BoundingBox;
  partial: boolean;
  status: IdentificationStatus;
  bricklinkId: BricklinkId | null;
  partId: PartId | null;
  colorId: ColorId | null;
  colorSource: ColorEstimate['source'];
  rawScore: number;
  confidence: number;
  level: ConfidenceLevel;
}
/** EX_11 export. Contains no image and no personal data. */
export interface CalibrationSession {
  version: 1;
  id: string;
  createdAt: string;
  platform: string;                 // `${Platform.OS} ${Platform.Version}`
  appVersion: string;
  background: BackgroundQuality;
  timings: ScanTimings;
  config: { thresholds: { accepted: number; review: number }; scoreCalibration: readonly (readonly [number, number])[] };
  detections: CalibrationDetection[];
  expected: CountedLine[];
  metrics: CalibrationMetrics;
}

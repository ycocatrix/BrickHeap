# BrickHeap — Phase 3 implementation plan

Status: **contract for parallel implementation**. Written 2026-11-14 from `docs/FUNCTIONAL_SPECS.md`,
`docs/UX_UI_MOCKUPS.md`, `docs/mockups-preview.html`, `docs/ARCHITECTURE_CLOUD.md`, the Phase 2 skeleton and three
research briefs (Expo SDK 58 / Expo Go, vision + catalogue APIs, Supabase).

Tags used below: **[E]** = Expo brief finding, **[V]** = vision brief finding, **[S]** = Supabase brief finding,
**(verify)** = not verified at runtime, the implementer must check the installed `.d.ts` or the versioned docs
(`https://docs.expo.dev/versions/v58.0.0/`, see `AGENTS.md`) before relying on it.

**Revision 2 (2026-11-15)** after three adversarial reviews (feasibility, coverage, parallelism). Main changes:
- AES session storage encrypts UTF-8 bytes.
- Boot never awaits Supabase.
- One SQLite write gate.
- Provisional parts are shown immediately and never synced while pending.
- Adaptive live loop with yielding segmentation and the Android orientation guard.
- Crops kept for review decisions; the line chooser handles RG_04.
- Snackbar rule; coloured tile images and French labels.
- Sync rules hardened: absent rows, first-sync name mapping, deleted lists ignored, deterministic name dedupe,
  generation guard, chunking and poison-batch recovery.
- Asserted SQL tests with a shared scenario table.
- Own-files-only hand-back checks.
- Value-based secret check.

Rejected or replaced:
- The WP0 on-device performance spike: no agent can run Expo Go on a phone. It is replaced by a go/no-go rule at
  the gate (R2).
- The server-side `ignored_lists` response: once remote tombstones are excluded from the guest merge, the only
  refused live list is a concurrent delete, where "a list delete is final" is the documented rule.
- The server-side rename RPC: pending provisional parts are never pushed, so a rename only ever moves unpushed rows.
- The `bricklink` retry for pulled ids: a pulled id is always either a Rebrickable id or a final `not_found`.
- Blocking `ensureDefaultList` before the first pull: it is redundant with the first-sync name mapping and
  `dedupeListNames`.

## 0. How this plan is executed

1. **WP0 (foundation) runs alone, first.** It installs dependencies, writes every shared file, and seeds a
   compiling stub for **every** module and screen listed in §4 (exact signatures, bodies `throw notImplemented()` or
   a placeholder screen). After WP0, `npx tsc --noEmit` and `npx jest` pass.
2. **WP1–WP8 run in parallel** in the same working tree. Each package edits only the files in its "owns" list
   (§5). A stub seeded by WP0 belongs to the package listed as its owner from then on; WP0 never runs again.
   Nobody edits a file owned by another package. If a contract in §4 is wrong or insufficient, the implementer
   does **not** change the other package's file: it adapts inside its own files and records the gap in its
   hand-back note for the gate.
3. **Gate (orchestrator, after all packages)**: §5.10 checklist, then the device test script (§7.4).

Rules for every implementer:

- Expo Go only. No dependency beyond §2. No `ios/` or `android/` directory. Read `AGENTS.md` first.
- Never print, log, commit or copy values from `.env`. Never commit or push. No remote mutation
  (`supabase db push`, `functions deploy`, `config push`, `secrets set`): those are user actions (§8.3).
- Logic that can be pure goes in `src/domain/**` with Jest tests; no React Native import there.
- Every user-facing string is French and lives in `src/i18n/fr/*.ts`. No literal French text in screens/components.
- Services never throw for expected failures; they return `Result<T>` (§4.1). A screen always has a way out
  (retry, back, continue without) — see the state matrix in §7.3.
- Every SQLite **write** goes through `withWrite` (§4.2); queries inside it use the `tx` handed to the callback,
  never `db()`, and never call another gated function (pass `tx` instead).
- Components declare their return type as `ReactElement` / `ReactElement | null` (`import type { ReactElement }
  from 'react'`); there is no global `JSX` namespace in `@types/react` 19.3.
- **Hand-back check (own files only)** — the tree is shared with seven other agents, so whole-tree results say
  nothing about your package:
  `npx tsc --noEmit 2>&1 | grep -E '<regex of your owned paths>'` must print nothing,
  `npx eslint <your owned paths>` must pass, `npx jest <your test paths>` must pass.
  Diagnostics in files you do not own are listed in the hand-back note and **never fixed by you**. The
  whole-tree commands (`tsc`, `jest`, `expo lint`) run only at the gate (§5.10).

## 1. Decisions

| # | Decision | Rationale (research finding) |
|---|---|---|
| D1 | **Pixels**: `expo-image-manipulator` (new `ImageManipulator.manipulate()` context API) renders a small **PNG**, read with `new File(uri).bytes()` (expo-file-system, a `Uint8Array` passed **as is** to `UPNG.decode`, never its `.buffer`) and decoded by **`upng-js`**. No base64, no `atob`, no JPEG decoder. | [E] `manipulateAsync` is deprecated; `File.bytes()` returns a `Uint8Array`; upng-js is plain CommonJS, ~2× faster than jpeg-js at 320 px and lossless (no chroma bleed). `atob`/`TextDecoder` on Hermes are unverified, this path needs neither. Skia rejected as too heavy. |
| D2 | **Pile segmentation runs on the device in pure JS**, once per captured image (never per preview frame), on a ≤ 320 px thumbnail (≤ 256 px, adaptively 192 px, in live mode). It is a TypeScript port of the research prototype (Appendix A), written as stages that **yield to the event loop** between them (`segmentPileAsync`) so touches and animations keep running. | [V] 0.93–0.96 precision / 0.90–0.96 recall on plain backgrounds (synthetic). Measured with `node --jitless` on the dev Mac (closest local proxy for Hermes): 442 ms at 320×240, 298 ms at 256×192, upng decode of 320×240 40 ms → **estimated 0.6–1.2 s of JS per image on a mid-range Android** (not measured on a phone; recorded by device script I2). Brickognize returns **one** box per image, so the client must segment. No usable free hosted detector exists (all Hugging Face candidates sleeping or broken) → `EXPO_PUBLIC_DETECTOR_URL` and the "Hugging Face/TFLite" options are dropped. |
| D3 | **One camera configuration for both modes**: `pictureSize` ≈ 1920 px long side (iOS preset `"1920x1080"`; Android: the smallest **4:3** size with long side ≥ 1920 from `getAvailablePictureSizesAsync()`, chosen once, cached in kv `camera.pictureSize` and passed on the first render of later launches so the camera binds once), never `skipProcessing`, never `ratio`. Explorer snapshots use `quality 0.6`, Inventorier capture `quality 0.85`. | [E] Changing `pictureSize` reconfigures the session (the mode switch must not reset the camera, mockups §2); on Android one `ResolutionSelector` drives both Preview and ImageCapture, and CameraX prefers 4:3 for the preview, so a 4:3 photo keeps photo and preview aspects equal. `skipProcessing` makes orientation device-dependent. Crops are sent at 320 px, so 12 MP is useless. |
| D4 | **Identification**: one JPEG crop (320 px long side, q 0.8) per box → Brickognize `POST /predict/parts/?predict_color=true&top_k_items=5&top_k_colors=3&min_similarity_items=0.25`, **pool of 4**, retry on 429 honouring `x-retry-in` / `retry-after`, client budget 90 calls/min, all behind `src/services/brickognize.ts`. If segmentation finds nothing or the background is `patterned`, the whole photo is sent once (single-piece fallback). | [V] 6 parallel calls OK, bursts of 20–30 get 429 with `retry-after: 1`; median latency 0.21 s; 256–384 px crops keep accuracy (96 px loses it); the anonymous API may become metered → single interface. |
| D5 | **RG_04 thresholds apply to a calibrated confidence**, not to the raw Brickognize similarity: piecewise-linear `calibrateScore` (raw 0.50 → 50 %, 0.65 → 80 %, 0.90 → 99 %), capped at 79 % when the top-2 candidates are within 0.05 or the crop's own box score is < 0.5. The curve is a constant in `src/domain/pile/thresholds.ts`, tuned with Calibration mode. | [V] Correct answers score only 0.65–0.85 raw; with raw thresholds almost nothing would ever be "acceptée". The default curve is derived from synthetic data and **must be validated on device** (§7.4). |
| D6 | **Colour**: Brickognize colour first (BrickLink colour id → Rebrickable id through the palette), cross-checked by the local estimate (dominant Lab from the segmentation mask → CIEDE2000 against a fixed list of 40 common opaque colours). Disagreement or low score → « couleur à confirmer » (RG_06). The palette (275 colours + 76 categories) is **bundled as a seed JSON** and refreshed through the proxy at most every 30 days. | [V] Brickognize colour ≈ 27/29 top-1 and handles transparents; local matching is unusable against all 229 opaque colours (top-1 0.11) but 0.76 / 0.96 (top-1 / top-3) against the 40 most common colours (33 of them opaque; the plan's list extends it to 40 opaque colours). A bundled palette makes colour work offline and at first launch with zero calls. |
| D7 | **ID mapping**: Brickognize ids are BrickLink-flavoured and are never used as catalogue ids directly. `catalog-proxy` maps them in **one batched call per scan** (cache-aside in Postgres + local SQLite cache). Every identified piece gets its **provisional part** (id = Brickognize id, name and image from Brickognize, `source: 'brickognize'`, `resolution: 'pending'`) **immediately** after Brickognize answers, so grouping and the drawer never wait for the catalogue; the resolved part replaces it when the proxy answers. A provisional part stays `pending` while the proxy is unreachable or answers `pending`, and becomes `not_found` only on an explicit `not_found`. **Inventory rows whose part is `pending` are never pushed by sync** (they count as « en attente du catalogue »): their reconciliation (`renamePart`) therefore always happens on unpushed rows, before the first push, and never as cross-device deltas. | [V] `3062`→`3062b`, `4073`→`6141`, `3001special`→no match; `?search=` must not be used. [S] Free projects pause after a week of inactivity, functions may not be deployed yet → the scan→inventory loop must not depend on Supabase being up. |
| D8 | **Grouping, thresholds, review edits, merge, export, sync planning are pure functions** in `src/domain`, covered by Jest. The review screen state is `pieces + overrides`; lines are always re-derived by `groupPieces`. | Spec RG_04–RG_10; sobriety (no duplicated state). |
| D9 | **Explorer "live" = adaptive auto-snapshot loop**: single-flight `takePictureAsync` every ≥ 2.5 s (no shutter sound/animation); the photo itself is the frame (no work-image re-encode), **one** manipulator context renders the ≤ 256 px PNG thumbnail; boxes drawn over the live preview with a pure "cover" mapping, IoU tracker (RG_02). Only tracks seen in **2 consecutive snapshots** are cropped (from the photo) and sent to Brickognize, each once. A slow cycle **stretches the interval** (up to 6 s) and lowers the thumbnail to 192 px instead of failing; only thrown captures/ingests count as failures (3 in a row → manual « Analyser »); a setting disables live. A snapshot whose orientation disagrees with the portrait view (Android rotation, see R3) is skipped silently. Tapping a box freezes on the snapshot and identifies that box if needed. In Inventorier the loop only segments: the drawer shows the count header only, a box tap does nothing, identification happens at capture. | [E] expo-camera has **no frame API**; periodic capture is the only option; iOS photo = preview field of view, Android photo = full sensor frame (cover mapping handles both, to verify on device). EX_01's "≥ 10 fps" holds for the native preview only; box refresh is ≈ 0.4 Hz → spec wording updated (§8.4). A moving camera produces no stable track, hence zero API calls. |
| D10 | **Local store = expo-sqlite** (`brickheap.db`): lists, items, sync metadata, catalogue cache. It is the single source of truth for inventory in guest and signed-in modes. **All writes are serialised by one JS write gate** (`withWrite`, a promise queue around `withExclusiveTransactionAsync`): user edits and sync never interleave inside a read-modify-write. Small key-values (settings, `entered` flag, session-user snapshot, encrypted session) use `expo-sqlite/kv-store`. `@react-native-async-storage/async-storage` is removed. | [E] expo-sqlite is in Expo Go; kv-store is a drop-in with sync getters, which avoids a settings loading state. SDK 58 docs: `withTransactionAsync` is **not** exclusive (any concurrent query joins the transaction) and concurrent writes during `withExclusiveTransactionAsync` fail with "database is locked" → a JS-level queue is required. |
| D11 | **Sync = quantity deltas through one idempotent RPC** (`public.sync`), no realtime, no polling. Each local item keeps `quantity` and `base_quantity`; a push sends `quantity − base_quantity`. Triggers: foreground, 2 s after a local mutation, manual, login. | [S] Row-level last-write-wins loses concurrent increments, which contradicts RG_08/RG_11. Tested replay/concurrency scenarios on a local Postgres. `ARCHITECTURE_CLOUD.md` ("last-write-wins") is updated. |
| D12 | **Auth = e-mail + password, plus 6-digit e-mail codes** for sign-up confirmation, passwordless login ("code de connexion") and password reset (`verifyOtp`). Deep-link callback is implemented as a bonus only. **No Apple / Google button in V1.** Session JSON is AES-GCM encrypted (`expo-crypto`, plaintext passed as **UTF-8 bytes**, decrypted bytes decoded with the pure `utf8Decode`), key in SecureStore, ciphertext in kv-store. **Boot never awaits a Supabase call**: the signed-in user is restored from a kv snapshot; offline with an expired token is "offline", not "signed out". The app uses the **publishable** key. | [E][S] `scheme` has no effect in Expo Go and `exp://<lan-ip>` links are unstable; codes need no deep link. Apple identity tokens are issued for Expo Go's bundle, native Google sign-in needs custom native code. SecureStore values above ≈ 2 KB can be refused on iOS. `@supabase/server` rejects legacy anon keys. |
| D13 | **Guest mode is purely local** (no anonymous Supabase user). A persisted `entered` flag (set by "Continuer sans compte" or by a successful sign-in, cleared only by explicit sign-out / account deletion) opens the app; session expiry never locks local data (RG_12). Guest → account merge = pull, confirm, then let the ordinary delta push add quantities (RG_11). | [S] Anonymous sign-ins need network at first launch, are rate-limited and never cleaned up. |
| D14 | **`catalog-proxy`**: one Edge Function, `verify_jwt = false`, `auth: 'publishable'`, five operations (`parts`, `part_colors`, `detail`, `set_qty`, `palette`), ≤ 50 ids per call, sequential upstream calls, negative caching, stale-if-error. Rebrickable key only in the function secret. | [S][V] Rebrickable ≈ 1 req/s, "severely overloaded", IP bans for repeat offenders; `parts/?part_nums=` is batched, `bricklink_id=` is one id per call. |
| D15 | **EX_14 quantity per set is loaded on demand** (tap on a set row → one cached upstream call); the list itself shows visual, number, year. Dimensions (EX_12) are parsed from the part name. | [V][S] The "sets containing part+colour" endpoint has no quantity; it costs one 95 KB call per set. No dimensions field exists. |
| D16 | **Navigation**: Expo Router, JS `Tabs`, `Stack.Protected` guards. Every file in `src/app` is a 1–3 line re-export of a screen in `src/screens/**`, so routes are owned by WP0 and screens by feature packages. No typed-routes experiment; hrefs come from `src/navigation/routes.ts`. | [E] Native tabs have layout limits; typed routes are beta and generated only by `expo start`. |
| D17 | **State**: no state library. A 15-line `createStore` + `useStore` (`useSyncExternalStore`) for session, settings, scan session and sync status; SQLite + a topic emitter (`useDbVersion`) for persisted data. | Four small stores, no middleware/devtools need; routes are separate trees so React context alone would force providers in the root layout owned by WP0. zustand would be one more dependency for the same 15 lines. |
| D18 | **i18n**: no library. `src/i18n/fr/<area>.ts` modules (one per package, typed `as const`) + `src/i18n/format.ts` (`tpl`, `plural`, `fmtPercent`, `fmtBadge`). V1 ships French only; the "Langue" row is read-only. Catalogue names get a **French display label without any API**: the 76 category names are bundled in French (`src/i18n/fr/catalog.ts`), part names go through the pure `partLabel(name)` (leading-word map, ~25 entries: Brick → Brique, Plate → Plaque, Tile → Tuile, Slope → Pente…, fallback = original name), used for display, accessibility labels and as an extra search field. The official English name stays visible on the fiche (EX_12 « nom officiel »). Colour names are translated for the common palette. | Sobriety; centralised strings without cross-package edits; a French user searching « brique » must find bricks. |
| D19 | **No gesture-handler / reanimated / skia / netinfo / web-browser / document-picker.** Drawer and sheets use `Animated` + `PanResponder` + RN `Modal`; offline is detected from failed requests; external links use `Linking.openURL`. | [E] Transitive gesture-handler 3.5.0 and worklets 0.13.1 drift from what Expo Go bundles; avoiding them removes the risk. |
| D20 | **Tests**: Jest (jest-expo preset) on pure domain code only. No component tests in V1. | [E] `react-test-renderer` is dead for React 19; RNTL v14 API unverified. UI is covered by the device script. |

## 2. Dependencies (WP0 installs; nothing else may be added)

```bash
cd /Users/ycocatrix/Documents/GitHub/BrickHeap
# Expo SDK modules — all bundled in Expo Go SDK 58 [E]
npx expo install expo-image-manipulator expo-file-system expo-sqlite expo-crypto expo-sharing expo-haptics expo-image @expo/vector-icons
# pure JS (CommonJS, pulls pako 1.x)
npx expo install upng-js
# removed (replaced by expo-sqlite/kv-store)
npm uninstall @react-native-async-storage/async-storage
# lint (creates eslint.config.js + dev deps on first run)
npx expo lint
# checks
npx expo install --check && npx expo-doctor
```

Expected versions (from `node_modules/expo/bundledNativeModules.json`): expo-image-manipulator `~58.0.16`,
expo-file-system `~58.0.13`, expo-sqlite `~58.0.17`, expo-crypto `~58.0.8`, expo-sharing `~58.0.23`,
expo-haptics `~58.0.8`, expo-image `~58.0.18`, @expo/vector-icons `^15.0.2`.

Forbidden: `react-native-get-random-values`, `aes-js`, `@shopify/react-native-skia`, `fast-png`, `jpeg-js`,
`zustand`, `react-native-gesture-handler`, `react-native-reanimated`, `react-native-vision-camera`,
`react-native-mmkv`, any google-signin library, `expo-apple-authentication`, `@testing-library/react-native`,
any i18n library.

## 3. Navigation map (all routes, owned by WP0)

Each route file contains only `export { default } from '@/screens/...';` (or the layout). Screens are default
exports of the files named in the last column.

| Route file (`src/app/…`) | Path | Guard | Presentation | Screen (`src/screens/…`) | Owner of the screen |
|---|---|---|---|---|---|
| `_layout.tsx` | — | — | root `Stack`, `headerShown: false` | — | WP0 |
| `+not-found.tsx` | * | none | card | `NotFoundScreen.tsx` | WP0 |
| `welcome.tsx` | `/welcome` | `!entered` | card | `auth/WelcomeScreen.tsx` (A1) | WP7 |
| `(auth)/_layout.tsx` | — | none | `Stack` | — | WP0 |
| `(auth)/login.tsx` | `/login` | none | card | `auth/LoginScreen.tsx` (A2) | WP7 |
| `(auth)/signup.tsx` | `/signup` | none | card | `auth/SignupScreen.tsx` (A3) | WP7 |
| `(auth)/forgot.tsx` | `/forgot` | none | card | `auth/ForgotScreen.tsx` (A4) | WP7 |
| `(auth)/verify.tsx` | `/verify?email&purpose` | none | card | `auth/VerifyCodeScreen.tsx` | WP7 |
| `(auth)/new-password.tsx` | `/new-password` | none | card | `auth/NewPasswordScreen.tsx` | WP7 |
| `auth/callback.tsx` | `/auth/callback` | none | card | `auth/AuthCallbackScreen.tsx` | WP7 |
| `about.tsx` | `/about` | none | card | `account/AboutScreen.tsx` (about, legal, privacy, CGU) | WP7 |
| `(tabs)/_layout.tsx` | — | `entered` | JS `Tabs` + Ionicons | — | WP0 |
| `(tabs)/index.tsx` | `/` | `entered` | tab "Scanner" | `scanner/ScannerScreen.tsx` (B1, B2, B4) | WP4 |
| `(tabs)/inventory.tsx` | `/inventory?listId` | `entered` | tab "Inventaire" | `inventory/InventoryScreen.tsx` (C2, C5) | WP6 |
| `(tabs)/lists.tsx` | `/lists` | `entered` | tab "Listes" | `lists/ListsScreen.tsx` (C3) | WP6 |
| `(tabs)/account.tsx` | `/account` | `entered` | tab "Compte" | `account/AccountScreen.tsx` (A5) | WP7 |
| `scan/review.tsx` | `/scan/review` | `entered` | card | `scanner/ReviewScreen.tsx` (B3) | WP4 |
| `part/[partId].tsx` | `/part/:partId?colorId` | `entered` | card (mockup C1 shows a back chevron) | `part/PartScreen.tsx` (C1) | WP5 |
| `export.tsx` | `/export?listId` | `entered` | `formSheet`, detents `[0.6]`, grabber | `export/ExportSheet.tsx` (C4) | WP6 |
| `settings/index.tsx` | `/settings` | `entered` | card | `settings/SettingsScreen.tsx` (A6) | WP7 |
| `settings/calibration.tsx` | `/settings/calibration` | `entered` | card | `settings/CalibrationScreen.tsx` | WP7 |
| `profile.tsx` | `/profile` | `entered` | card | `account/ProfileScreen.tsx` | WP7 |
| `change-password.tsx` | `/change-password` | `entered` | card | `account/PasswordScreen.tsx` | WP7 |

Root layout (WP0), final shape:

```tsx
// src/app/_layout.tsx
SplashScreen.preventAutoHideAsync();               // exported by expo-router [E]
export default function RootLayout() {
  const boot = useBoot();                          // openDb() → loadSettings() → initSession() (sync, kv only); no network
  const entered = useStore(sessionStore, (s) => s.entered);
  useEffect(() => (boot.status === 'ready' ? startSync() : undefined), [boot.status]);
  if (boot.status === 'loading') return null;      // splash still visible
  if (boot.status === 'error') return <BootErrorScreen error={boot.error} onRetry={boot.retry} />;
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={!entered}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
        <Stack.Protected guard={entered}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="scan/review" />
          <Stack.Screen name="part/[partId]" />
          <Stack.Screen name="export" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6], sheetGrabberVisible: true }} />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/calibration" />
          <Stack.Screen name="profile" />
          <Stack.Screen name="change-password" />
        </Stack.Protected>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="auth/callback" />
        <Stack.Screen name="about" />
      </Stack>
      <GuestMergeHost />   {/* WP8 */}
      <SnackbarHost />     {/* WP1 */}
    </>
  );
}
```

- `SplashScreen.hide()` is called by `useBoot` when it settles. Scanner is the initial tab; nothing on the boot
  path waits for the network and **no `supabase.auth` call is awaited** (acceptance: camera active in < 3 s, also
  offline with an expired access token).
- The tab bar is hidden on root-stack screens (`scan/review`, `part/[partId]`, `export`, `settings/*`, `profile`,
  `change-password`): a recorded deviation from mockups B3/C1 and UX §2bis (§8.4).
- **Snackbar rule**: `SnackbarHost` is a sibling of the root `Stack`, so it is hidden by RN `Modal` sheets and by
  `formSheet` screens. Any action that shows a snackbar first closes the sheet it was triggered from; `formSheet`
  screens (`export`) never use a snackbar and show their result inline.
- Guards only switch between `welcome` and the app. Auth screens navigate explicitly after success:
  `router.dismissAll(); router.replace('/')`. `Stack.Protected` behaviour (redirect target when the guard flips,
  first-launch landing on `welcome`) **(verify)** against `https://docs.expo.dev/router/advanced/authentication.md`;
  if a guarded initial route does not redirect to `welcome`, add `<Redirect href="/welcome" />` logic in
  `(tabs)/_layout.tsx`.
- Tabs: `Ionicons` — `scan-outline` Scanner, `cube-outline` Inventaire, `list-outline` Listes,
  `person-outline` Compte; active = `colors.primary` **and** bold label (never colour alone).
- No header from the navigator anywhere: titles/back buttons come from `Screen` (WP1). `formSheet` has no native
  header on Android; the sheet content carries its title.

```ts
// src/navigation/routes.ts (WP0) — the only place hrefs are written
import type { Href } from 'expo-router';
export type CodePurpose = 'signup' | 'login' | 'recovery';
export const routes = {
  welcome: '/welcome' as Href,
  login: '/login' as Href,
  signup: '/signup' as Href,
  forgot: '/forgot' as Href,
  verify: (email: string, purpose: CodePurpose): Href => ({ pathname: '/verify', params: { email, purpose } }),
  newPassword: '/new-password' as Href,
  about: '/about' as Href,
  scanner: '/' as Href,
  inventory: (listId?: string | null): Href => ({ pathname: '/inventory', params: { listId: listId ?? '' } }),
  lists: '/lists' as Href,
  account: '/account' as Href,
  review: '/scan/review' as Href,
  part: (partId: string, colorId?: number | null): Href =>
    ({ pathname: '/part/[partId]', params: { partId, colorId: colorId == null ? '' : String(colorId) } }),
  exportSheet: (listId?: string | null): Href => ({ pathname: '/export', params: { listId: listId ?? '' } }),
  settings: '/settings' as Href,
  calibration: '/settings/calibration' as Href,
  profile: '/profile' as Href,
  changePassword: '/change-password' as Href,
};
```

## 4. Shared contracts

Conventions for everything below:

- `Result<T>`: expected failures are values, never exceptions. `AppError.message` is a French, user-facing sentence.
- Coordinates: every `BoundingBox` is **normalised to 0..1**, origin top-left, relative to the analysed image
  (`ScanFrame`), unless a name says `Pixel`.
- Async functions documented "never rejects" must catch everything.
- Hooks return `{ data, loading, error, reload }` (`useAsync`, §4.2).

### 4.1 `src/domain/types.ts` (WP0 — full source, do not change in WP1–WP8)

```ts
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
```

### 4.2 Foundation modules (WP0 implements fully)

```ts
// src/domain/result.ts
export const ok: <T>(value: T) => Result<T>;
export const err: (code: AppErrorCode, message: string, cause?: unknown) => Result<never>;
export function notImplemented(what?: string): never;                 // used by stubs only
/** Maps a thrown value / fetch failure / HTTP status to an AppError with the French message from common.errors. */
export function toAppError(e: unknown, httpStatus?: number): AppError;
//   TypeError('Network request failed') / AbortError → offline / timeout · 401,403 → unauthorized · 404 → not_found
//   429 → rate_limited · ≥ 500 → server · else unknown

// src/domain/utf8.ts — pure JS (~20 lines), no TextEncoder/TextDecoder (unverified under Hermes)
export function utf8Encode(s: string): Uint8Array;                    // handles surrogate pairs
export function utf8Decode(bytes: Uint8Array): string;                // invalid sequences → U+FFFD

// src/domain/keys.ts
export function itemKey(partId: PartId, colorId: ColorId): string;    // `${partId}|${colorId}`
export function parseItemKey(key: string): { partId: PartId; colorId: ColorId } | null;
export function sameRef(a: ItemRef, b: ItemRef): boolean;

// src/services/env.ts — only EXPO_PUBLIC_* values; no secret
export const env: { supabaseUrl: string; supabaseKey: string; brickognizeUrl: string };
//   supabaseKey = EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''
export function isSupabaseConfigured(): boolean;                       // unchanged semantics (smoke test stays green)

// src/services/kv.ts — synchronous key-value over `expo-sqlite/kv-store` (getItemSync/setItemSync/removeItemSync)
export const kv: {
  getString(key: string): string | null;
  setString(key: string, value: string): void;
  remove(key: string): void;
  getJson<T>(key: string, fallback: T): T;                             // fallback on missing or unparsable value
  setJson(key: string, value: unknown): void;
};
// kv keys in use: 'entered', 'settings', 'session.user' (SessionUser JSON snapshot), 'sb.<supabase storage key>',
//   'camera.pictureSize' (Android, D3)

// src/services/supabase.ts
export const supabase: SupabaseClient | null;                          // null when !isSupabaseConfigured()

// src/state/createStore.ts
export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(listener: () => void): () => void;
}
export function createStore<S extends object>(initial: S): Store<S>;
/** The selector must return a primitive or an existing reference (select a field, never build an object). */
export function useStore<S, T>(store: Store<S>, selector: (s: S) => T): T;

// src/state/session.ts
export interface SessionState {
  status: 'loading' | 'ready';
  user: SessionUser | null;
  /** The user passed the welcome screen (guest or signed in). Persisted in kv 'entered'. */
  entered: boolean;
  configured: boolean;                                                  // isSupabaseConfigured()
}
export const sessionStore: Store<SessionState>;
/** SYNCHRONOUS, never awaits supabase (auth-js refreshes an expired token inside getSession/INITIAL_SESSION and
 *  retries for up to ~30 s offline). Steps: status 'ready', `entered` from kv, `user` from the kv snapshot
 *  'session.user'; then, in the background, subscribes to onAuthStateChange and registers the AppState
 *  auto-refresh toggle (RG_12). Events: SIGNED_IN / USER_UPDATED / TOKEN_REFRESHED → user = toSessionUser(session),
 *  snapshot written, entered = true (SIGNED_IN only); SIGNED_OUT → user = null, snapshot removed;
 *  INITIAL_SESSION with null is IGNORED (it is also emitted when an offline refresh fails while the refresh
 *  token is still valid). auth-js emits SIGNED_OUT itself after a non-retryable refresh error. Idempotent. */
export function initSession(): void;
/** id, email, user_metadata.pseudo (string or null). */
export function toSessionUser(session: { user: { id: string; email?: string | null;
  user_metadata?: Record<string, unknown> } }): SessionUser;
export function enterAsGuest(): void;                                   // entered = true
export function leaveApp(): void;                                       // entered = false (after sign-out / deletion)
export function useSession(): SessionState;

// src/state/settings.ts
export const DEFAULT_SETTINGS: Settings;
export const settingsStore: Store<Settings>;
export function loadSettings(): void;                                   // sync, from kv 'settings' merged over defaults
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;   // persists
export function useSetting<K extends keyof Settings>(key: K): Settings[K];

// src/data/db.ts
export const DB_NAME = 'brickheap.db';
/** Opens the database and runs migrations (PRAGMA user_version). Rejects only on an unrecoverable error. */
export function openDb(): Promise<void>;
/** The opened database, for READS only. Throws Error('db not ready') before openDb() resolved. */
export function db(): SQLiteDatabase;
/** The single write gate. Callbacks run one at a time, in call order (JS promise queue), each inside
 *  db().withExclusiveTransactionAsync; the callback must issue every query on `tx` (never on db()) and must not
 *  call withWrite or any gated function (deadlock) — pass `tx` down instead. A rejection rolls back that
 *  callback's transaction only and is re-thrown to its caller; the queue continues. Reads outside the gate are
 *  allowed (WAL) but must not be used to compute a write: read-modify-write happens entirely inside one callback.
 *  (verify) in the installed expo-sqlite that withExclusiveTransactionAsync runs on its own connection. */
export function withWrite<T>(fn: (tx: SQLiteDatabase) => Promise<T>): Promise<T>;

// src/data/dbEvents.ts
/** 'mutation' = a local user change that must be synced (emitted by inventoryRepo only, never by sync). */
export type DbTopic = 'inventory' | 'lists' | 'catalog' | 'mutation';
export function notify(...topics: DbTopic[]): void;
export function subscribe(topic: DbTopic, listener: () => void): () => void;
/** Increments whenever one of the topics is notified; use as an effect dependency. */
export function useDbVersion(...topics: DbTopic[]): number;

// src/data/meta.ts — `meta` table
export type MetaKey = 'owner_uid' | 'device_id' | 'since' | 'pending_batch' | 'last_list_id' | 'palette_fetched_at';
/** With `tx`: runs on it (caller already inside withWrite). Without: getMeta reads db(), setMeta uses withWrite. */
export function getMeta(key: MetaKey, tx?: SQLiteDatabase): Promise<string | null>;
export function setMeta(key: MetaKey, value: string | null, tx?: SQLiteDatabase): Promise<void>;   // null deletes
export function getDeviceId(): Promise<string>;                                  // creates a UUID on first call

// src/hooks/useAsync.ts
export interface AsyncState<T> { data: T | undefined; loading: boolean; error: AppError | null; reload: () => void }
/** Runs `fn` on mount and whenever deps change; ignores stale results; maps rejections with toAppError. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T>;
export function useAsyncResult<T>(fn: () => Promise<Result<T>>, deps: readonly unknown[]): AsyncState<T>;

// src/hooks/useBoot.ts
export function useBoot(): { status: 'loading' | 'ready' } | { status: 'error'; error: AppError; retry: () => void };

// src/i18n/format.ts
export function tpl(template: string, vars: Record<string, string | number>): string;   // replaces {name}
export function plural(n: number, one: string, other: string): string;                  // French: |n| < 2 → one
export function fmtPercent(confidence: number): string;                                 // 0.923 → '92 %'
export function fmtBadge(quantity: number): string;                                     // 7 → '7', 120 → '99+'
export function fmtCount(n: number): string;                                            // 1234 → '1 234' (no Intl)

// src/i18n/fr/common.ts
export const common: {
  appName: 'BrickHeap';
  tabs: { scanner: 'Scanner'; inventory: 'Inventaire'; lists: 'Listes'; account: 'Compte' };
  actions: { retry: 'Réessayer'; cancel: 'Annuler'; close: 'Fermer'; back: 'Retour'; save: 'Enregistrer';
             delete: 'Supprimer'; confirm: 'Confirmer'; continue: 'Continuer'; undo: 'Annuler'; ok: 'OK';
             openSettings: 'Ouvrir les réglages' };
  errors: Record<AppErrorCode, string>;
  //   offline: 'Pas de connexion. Vérifiez votre réseau puis réessayez.'
  //   timeout: 'Le service met trop de temps à répondre. Réessayez.'
  //   rate_limited: 'Trop de demandes à la suite. Patientez un instant puis réessayez.'
  //   server: 'Le service est momentanément indisponible. Réessayez plus tard.'
  //   not_configured: 'La synchronisation n’est pas configurée sur cette installation.'
  //   unauthorized: 'Votre session a expiré. Reconnectez-vous.'
  //   invalid: 'Vérifiez les informations saisies.'
  //   not_found: 'Élément introuvable.'
  //   unknown: 'Une erreur inattendue est survenue. Réessayez.'
  legal: { notAffiliated: 'Projet indépendant, non affilié à LEGO®' };
  boot: { failedTitle: 'Impossible de démarrer'; failedMessage: 'Les données locales n’ont pas pu être ouvertes.' };
  notFound: { title: 'Écran introuvable'; action: 'Revenir au scanner' };
};

// src/i18n/fr/colors.ts
export const COLOR_NAMES_FR: Readonly<Record<number, string>>;         // table below
export function colorLabel(color: Pick<CatalogColor, 'colorId' | 'name'> | null): string;   // FR name, else Rebrickable name, '—' for null

// src/theme.ts (extends the existing `colors`)
export const colors: { bg; surface; line; text; muted; primary; ok; warn; error;      // unchanged values
                       tileBg: '#F1F2F5'; onPrimary: '#12141A'; white: '#FFFFFF'; overlay: 'rgba(0,0,0,0.55)' };
export const spacing: { xs: 4; sm: 8; md: 12; lg: 16; xl: 24 };
export const radius: { sm: 4; md: 10; lg: 16; pill: 999 };
export const font: { title: 22; h2: 18; body: 16; small: 13; tiny: 11 };
export const touch: { min: 48 };                                        // dp, acceptance criterion
export const levelColor: Record<ConfidenceLevel, string>;               // accepted → ok, review → warn, unknown → muted
export const levelIcon: Record<ConfidenceLevel, 'checkmark' | 'help' | 'remove'>;   // Ionicons names: ✓ / ? / –
```

**French colour names** (`COLOR_NAMES_FR`, Rebrickable colour ids checked against the live palette on 2026-11-14):

| id | FR | id | FR | id | FR | id | FR |
|---|---|---|---|---|---|---|---|
| 0 | Noir | 15 | Blanc | 4 | Rouge | 71 | Gris bleuté clair |
| 72 | Gris bleuté foncé | 14 | Jaune | 1 | Bleu | 19 | Beige |
| 70 | Brun rougeâtre | 2 | Vert | 25 | Orange | 28 | Beige foncé |
| 7 | Gris clair (ancien) | 27 | Vert citron | 272 | Bleu foncé | 47 | Transparent |
| 322 | Azur moyen | 320 | Rouge foncé | 84 | Nougat moyen | 191 | Orange clair vif |
| 29 | Rose vif | 36 | Rouge transparent | 484 | Orange foncé | 3 | Turquoise foncé |
| 46 | Jaune transparent | 288 | Vert foncé | 85 | Violet foncé | 378 | Vert sable |
| 41 | Bleu clair transparent | 321 | Azur foncé | 73 | Bleu moyen | 26 | Magenta |
| 30 | Lavande moyen | 8 | Gris foncé (ancien) | 5 | Rose foncé | 182 | Orange transparent |
| 308 | Brun foncé | 226 | Jaune clair vif | 33 | Bleu foncé transparent | 323 | Aqua clair |
| 10 | Vert vif | 212 | Bleu clair vif | 31 | Lavande | 379 | Bleu sable |
| 326 | Vert olive | 297 | Or perlé | 34 | Vert transparent | 6 | Brun |

**`createStore` (full source):**

```ts
import { useSyncExternalStore } from 'react';
export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
export function useStore<S, T>(store: Store<S>, selector: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
```

**Supabase client with encrypted session storage (RT_02, D12) — reference source.** Checked against the
published `expo-crypto@58.0.8` typings: `BinaryInput = string | Uint8Array | ArrayBuffer` where a **string must be
base64** (Android `Base64.decode`s it), and `aesDecryptAsync(sealed, key)` resolves to a **`Uint8Array`** unless
`{ output: 'base64' }` is passed. The session JSON is therefore encrypted as UTF-8 bytes and decrypted bytes are
decoded with the pure `utf8Decode` (no `TextDecoder`). `AESEncryptionKey.generate/import`, `key.encoded('base64')`,
`AESSealedData.fromCombined` and `sealed.combined('base64')` are async/sync as written below:

```ts
// src/services/supabase.ts
import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { env, isSupabaseConfigured } from './env';
import { kv } from './kv';
import { utf8Decode, utf8Encode } from '@/domain/utf8';

const KEY_NAME = 'brickheap.session-key';            // SecureStore: alphanumerics . - _ only
let keyPromise: Promise<AESEncryptionKey> | null = null;
const sessionKey = () =>
  (keyPromise ??= (async () => {
    const stored = await SecureStore.getItemAsync(KEY_NAME);
    if (stored) return await AESEncryptionKey.import(stored, 'base64');
    const key = await AESEncryptionKey.generate();   // 256-bit
    await SecureStore.setItemAsync(KEY_NAME, await key.encoded('base64'));
    return key;
  })());

// Key in the OS keystore, AES-GCM ciphertext in kv-store: a session JSON exceeds the ~2 KB SecureStore limit.
const storage = {
  async getItem(k: string): Promise<string | null> {
    const sealed = kv.getString('sb.' + k);
    if (!sealed) return null;
    try {
      const bytes = await aesDecryptAsync(AESSealedData.fromCombined(sealed), await sessionKey());  // Uint8Array
      return utf8Decode(bytes);
    } catch {                                        // key lost (reinstall) or corrupted value → signed out
      kv.remove('sb.' + k);
      return null;
    }
  },
  async setItem(k: string, v: string): Promise<void> {
    const sealed = await aesEncryptAsync(utf8Encode(v), await sessionKey());   // bytes, never a raw string
    kv.setString('sb.' + k, await sealed.combined('base64'));
  },
  async removeItem(k: string): Promise<void> { kv.remove('sb.' + k); },
};

export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(env.supabaseUrl, env.supabaseKey, {
      auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    })
  : null;                                            // guest-only installation

// RG_12: refresh only in the foreground (registered once, from initSession()).
export function registerAutoRefresh(): void {
  if (!supabase) return;
  AppState.addEventListener('change', (s) =>
    s === 'active' ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh());
}
```

If `expo-crypto` AES turns out not to work in Expo Go on a device (WP0 acceptance: `setItem` then `getItem` round
trip of a JSON string containing « é » on both platforms, then a cold restart still signed in), the fallback is
the documented Supabase `LargeSecureStore` with `aes-js` + `Crypto.getRandomValues` — a WP0-only change (adds
`aes-js`).

**Local database schema (`src/data/db.ts`, `PRAGMA user_version = 1`):**

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,                 -- ISO 8601
  deleted INTEGER NOT NULL DEFAULT 0,       -- tombstone kept until pushed
  dirty INTEGER NOT NULL DEFAULT 1          -- 1 = must be pushed
);
CREATE TABLE IF NOT EXISTS items (
  list_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  color_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),        -- 0 = hidden (RG_10), kept while base_quantity > 0
  base_quantity INTEGER NOT NULL DEFAULT 0,               -- server value at last sync; 0 for guests
  updated_at TEXT NOT NULL,                               -- local clock, display ordering only
  PRIMARY KEY (list_id, part_id, color_id)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY NOT NULL, v TEXT);

CREATE TABLE IF NOT EXISTS catalog_parts (
  part_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  category_id INTEGER,
  image_url TEXT,
  bricklink_ids TEXT NOT NULL DEFAULT '[]',               -- JSON array
  lego_ids TEXT NOT NULL DEFAULT '[]',                    -- JSON array
  print_of TEXT,
  year_from INTEGER,
  year_to INTEGER,
  source TEXT NOT NULL DEFAULT 'rebrickable',             -- 'rebrickable' | 'brickognize' (provisional)
  resolution TEXT NOT NULL DEFAULT 'resolved',            -- 'resolved' | 'pending' | 'not_found' (D7)
  fetched_at TEXT NOT NULL                                -- for 'not_found' rows: 7-day local negative cache
);
CREATE TABLE IF NOT EXISTS catalog_bl_map (               -- Brickognize id → catalogue part
  bricklink_id TEXT PRIMARY KEY NOT NULL,
  part_id TEXT,                                           -- NULL = no Rebrickable match (negative cache)
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_colors (
  color_id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  hex TEXT NOT NULL,
  is_trans INTEGER NOT NULL DEFAULT 0,
  bricklink_id INTEGER
);
CREATE TABLE IF NOT EXISTS catalog_categories (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_part_colors (
  part_id TEXT NOT NULL,
  color_id INTEGER NOT NULL,
  found INTEGER NOT NULL DEFAULT 1,
  element_ids TEXT NOT NULL DEFAULT '[]',                 -- JSON array
  image_url TEXT,
  num_sets INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (part_id, color_id)
);
```

`catalog_colors` / `catalog_categories` hold the palette refreshed through the proxy; while they are empty,
`getPalette()` uses the bundled seed JSON (the seed is not copied into the tables). `catalog_part_colors` also
receives one row per colour of a part from the `part_colors` operation (inventory tile images, §4.7).

Table ownership at runtime: `lists`/`items` are written by `inventoryRepo` (WP6) and `syncRepo` (WP8); `meta` by
`meta.ts`; `catalog_*` by `catalogRepo` (WP5) only. **Every write goes through `withWrite`.** Guests use the same
tables and simply never sync.

**Config files (WP0):**

- `app.json`: camera permission text → « BrickHeap utilise la caméra pour reconnaître vos briques. Les images
  sont envoyées au service Brickognize pour identification et ne sont pas conservées par BrickHeap. » ; keep
  everything else; accept plugin entries added by `npx expo install`.
- `tsconfig.json`: add `"exclude": ["node_modules", "supabase/functions"]` (Deno code must not be type-checked by
  `tsc`) [S].
- `package.json`: scripts `"lint": "expo lint"`, `"check": "tsc --noEmit && jest && expo lint"`; jest config
  unchanged (preset `jest-expo`, `@/` mapper).
- `.env.example`: replace `EXPO_PUBLIC_SUPABASE_ANON_KEY` by `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (comment:
  Project Settings > API keys > publishable `default`; the legacy anon key is still read as a fallback but
  `catalog-proxy` rejects it), remove `EXPO_PUBLIC_DETECTOR_URL`.
- `src/types/upng-js.d.ts`:
  ```ts
  declare module 'upng-js' {
    interface Image { width: number; height: number; depth: number; ctype: number; frames: unknown[]; data: ArrayBuffer }
    /** Pass the Uint8Array from File.bytes() directly: `view.buffer` breaks on a view with a non-zero byteOffset.
     *  Throws on a corrupt or empty file. */
    export function decode(buffer: ArrayBuffer | Uint8Array): Image;
    export function toRGBA8(image: Image): ArrayBuffer[];                // wrap [0] as new Uint8Array(...)
  }
  ```

### 4.3 UI kit (WP1) — `src/components/*`, `src/services/feedback.ts`

Props-only components, no data access, no navigation. Every pressable is ≥ 48 dp, has `accessibilityRole` and a
label; every status is icon + text + colour. Every file starts with
`import type { ReactElement, ReactNode } from 'react'` as needed.

```ts
// Icon.tsx
export type IconName = React.ComponentProps<typeof Ionicons>['name'];
export function Icon(p: { name: IconName; size?: number; color?: string }): ReactElement;

// Screen.tsx — safe-area top/left/right, title row with optional back button (label common.actions.back)
export function Screen(p: { title?: string; onBack?: () => void; right?: ReactNode; scroll?: boolean;
  footer?: ReactNode /* fixed bottom bar, bottom inset applied */; children: ReactNode }): ReactElement;

// Button.tsx
export function Button(p: { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName; loading?: boolean; disabled?: boolean; accessibilityHint?: string; style?: StyleProp<ViewStyle> }): ReactElement;
export function IconButton(p: { icon: IconName; /** a11y label, required */ label: string; onPress: () => void;
  active?: boolean; disabled?: boolean; size?: number }): ReactElement;

// TextField.tsx — label above, error below (icon + text, announced with accessibilityLiveRegion="polite")
export function TextField(p: Omit<TextInputProps, 'style'> & { label: string; error?: string | null;
  /** password field with a show/hide toggle */ secure?: boolean }): ReactElement;

// StateViews.tsx
export function LoadingState(p: { label?: string }): ReactElement;
export function EmptyState(p: { icon: IconName; title: string; message?: string; actionLabel?: string; onAction?: () => void }): ReactElement;
export function ErrorState(p: { error: AppError; onRetry?: () => void; secondaryLabel?: string; onSecondary?: () => void }): ReactElement;
export function Skeleton(p: { width?: DimensionValue; height: number; radius?: number }): ReactElement;

// Banner.tsx — inline message; tone drives icon + colour
export function Banner(p: { tone: 'info' | 'warn' | 'error' | 'ok'; text: string; actionLabel?: string;
  onAction?: () => void; onDismiss?: () => void }): ReactElement;

// Snackbar.tsx — one at a time, above the tab bar, announced to screen readers
export function showSnackbar(o: { text: string; actionLabel?: string; onAction?: () => void | Promise<void>;
  /** default 4000; undo snackbars use UNDO_MS */ durationMs?: number }): void;
export const UNDO_MS = 10000;                                           // RG_09 / EX_16
//   Snackbar rule (§3): callers close their sheet BEFORE calling showSnackbar; never used from a formSheet.
export function SnackbarHost(): ReactElement;                            // mounted once in the root layout

// Small pieces
export function ColorDot(p: { hex: string | null; size?: number; isTrans?: boolean }): ReactElement;   // null → hatched '?' dot
export function ConfidenceBadge(p: { level: ConfidenceLevel; confidence?: number; compact?: boolean }): ReactElement;
export function QuantityStepper(p: { value: number; onChange: (v: number) => void; min?: number /* 0 */;
  max?: number /* 9999 */; /** a11y subject, e.g. 'Brique 2 × 4 Rouge' */ label: string }): ReactElement;
//   − / value / +. The value is pressable: it turns into a numeric TextInput (keyboardType 'number-pad', select
//   all), validated on blur/submit, clamped to min..max, non-numeric input reverts; a11y label
//   « Quantité, {n}, modifier ». Long-press on − / + repeats every 100 ms.
export function QuantityBadge(p: { quantity: number }): ReactElement;    // yellow pill, fmtBadge
export function PartImage(p: { uri: string | null; size: number; accessibilityLabel?: string;
  /** Colour cue drawn on the image (ColorDot, bottom-left, white ring) — used when the image is not known to be
   *  the coloured one, so the tile never shows the wrong colour without saying which colour it is. */
  colorCue?: { hex: string; isTrans: boolean } | null }): ReactElement;
//   expo-image, contentFit 'contain', background colors.tileBg, cachePolicy 'disk', cube icon placeholder
export function Chip(p: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName }): ReactElement;
export function ListRow(p: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode;
  onPress?: () => void; destructive?: boolean; accessibilityLabel?: string }): ReactElement;
export function SwitchRow(p: { label: string; value: boolean; onValueChange: (v: boolean) => void; hint?: string }): ReactElement;
export function SegmentedControl<T extends string>(p: { options: { value: T; label: string }[]; value: T;
  onChange: (v: T) => void; accessibilityLabel: string }): ReactElement;

// Sheets — RN Modal (transparent, slide), backdrop press closes, bottom inset applied, accessibilityViewIsModal
export function BottomSheet(p: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }): ReactElement;
export function ColorPickerSheet(p: { visible: boolean; onClose: () => void; colors: CatalogColor[];
  /** shown first under « Suggestions » */ suggested?: ColorId[]; selected?: ColorId | null;
  onSelect: (colorId: ColorId) => void;
  /** Photo of the real piece (IdentifiedPiece.cropUri), shown at the top, next to the measured swatch. */
  referenceUri?: string | null; /** Detection.rgb as hex, « Couleur mesurée » swatch. */ measuredHex?: string | null }): ReactElement;
//   sections: suggestions · couleurs courantes (COMMON_OPAQUE_COLOR_IDS) · toutes ; search by FR/EN name; dot + name rows
export function ListPickerSheet(p: { visible: boolean; onClose: () => void; lists: ListSummary[];
  selectedId?: ListId | null; onSelect: (id: ListId) => void;
  /** inline « Nouvelle liste » field; error message shown under it */ onCreate: (name: string) => Promise<Result<List>> }): ReactElement;

// src/services/feedback.ts — respects settingsStore.haptics; never throws
export const feedback: { success(): void; warning(): void; error(): void; tap(): void };
//   Android: Haptics.performAndroidHapticsAsync; iOS: notificationAsync / selectionAsync. iOS haptics do not fire
//   while the camera is active [E] → scanner screens must also give a visual cue.
```

### 4.4 Vision core (WP2) — `src/domain/vision/*` (pure)

```ts
// config.ts — every tunable of the pipeline in one place
export const VISION: {
  picture: { longSide: 1920; liveQuality: 0.6; captureQuality: 0.85 };
  /** Captures: re-encode only when the photo's long side exceeds this. Live snapshots are never re-encoded. */
  workMaxSide: 1920;
  segMaxSide: { inventory: 320; explore: 256; exploreMin: 192 };
  crop: { outSide: 320; quality: 0.8; minSourceSide: 40 };       // px in the work image
  wholeImageSide: 640;
  nmsIou: 0.6;                                                      // RG_03
  trackIou: 0.5;                                                    // RG_02
  maxBoxes: 60;
  brickognize: { concurrency: 4; maxRetries: 3; timeoutMs: 10000; topKItems: 5; topKColors: 3;
                 minSimilarity: 0.25; budgetPerMinute: 90 };
  live: { intervalMs: 2500; maxIntervalMs: 6000; slowCycleMs: 2200; stableHits: 2; maxMisses: 1; maxFailures: 3 };
};

// segment.ts — port of the prototype (Appendix A)
export interface SegmentOptions { ring?: number; kSigma?: number; minTc?: number; minTL?: number; shadowFrac?: number;
  coreFrac?: number; minAreaFrac?: number; maxAreaFrac?: number; colorSplitDist?: number; lightSplitDist?: number;
  colorSplitMinFrac?: number; shapeSeedFrac?: number; shapeSplitRelArea?: number; nestedFrac?: number; pad?: number;
  maxDepth?: number }
export const SEGMENT_DEFAULTS: Required<SegmentOptions>;
/** Pure and deterministic. Throws RangeError when rgba.length !== width * height * 4 or a side is < 16 px.
 *  Implemented as a generator `function* segmentStages(...)` that `yield`s between stages (background fit,
 *  foreground + shadow pruning, morphology + labelling, each split pass, boxes + colours); segmentPile drives it
 *  to completion synchronously. */
export function segmentPile(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  options?: SegmentOptions): SegmentationResult;
/** Same generator, awaiting `yieldFn()` at every stage boundary so the JS thread processes touches and animation
 *  frames (the service passes `() => new Promise((r) => setTimeout(r, 0))`). Result deep-equals segmentPile's. */
export function segmentPileAsync(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  options: SegmentOptions | undefined, yieldFn: () => Promise<void>): Promise<SegmentationResult>;

// lab.ts
export function rgbToLab(r: number, g: number, b: number): Lab;       // sRGB D65
export function labToRgb(lab: Lab): Rgb;
export function hexToLab(hex: string): Lab;                             // 'C91A09' or '#C91A09'
export function ciede2000(a: Lab, b: Lab): number;

// color.ts
/** 40 most common opaque colours (Rebrickable ids), by number of sets over basic parts. */
export const COMMON_OPAQUE_COLOR_IDS: readonly ColorId[];
//   [0, 15, 4, 71, 72, 14, 1, 19, 70, 2, 25, 28, 7, 27, 272, 322, 320, 84, 191, 29, 484, 3, 288, 85, 378, 321, 73,
//    26, 30, 8, 5, 308, 226, 323, 10, 212, 31, 379, 326, 6]
export interface ColorMatch { colorId: ColorId; deltaE: number }
/** CIEDE2000 ranking. Skips transparent colours, colorId < 0 and 9999. Default k = 3. */
export function nearestColors(lab: Lab, colors: readonly CatalogColor[],
  opts?: { allowed?: ReadonlySet<ColorId>; k?: number }): ColorMatch[];

// geometry.ts
export function iou(a: BoundingBox, b: BoundingBox): number;            // 0 when disjoint or degenerate
/** Greedy NMS: sort by score desc, drop any item whose IoU with a kept item is > threshold (default VISION.nmsIou). */
export function nms<T extends { box: BoundingBox; score: number }>(items: readonly T[], iouThreshold?: number): T[];
export function clampBox(b: BoundingBox): BoundingBox;                  // inside [0,1], w/h ≥ 0
export function boxToPixelRect(b: BoundingBox, image: Size): PixelRect; // integers, ≥ 1 px, inside the image
export function fitWithin(size: Size, maxSide: number): Size;           // keeps aspect, never upscales, integers
export interface ViewTransform { scale: number; dx: number; dy: number }
/** Live preview (aspect-fill): s = max(vw/iw, vh/ih), centred. */
export function coverTransform(image: Size, view: Size): ViewTransform;
/** Frozen still (aspect-fit): s = min(vw/iw, vh/ih), centred. */
export function containTransform(image: Size, view: Size): ViewTransform;
export function boxToView(b: BoundingBox, image: Size, t: ViewTransform): { left: number; top: number; width: number; height: number };
export function viewToImagePoint(p: Point, image: Size, t: ViewTransform): Point | null;   // normalised; null outside
/** Smallest box containing the normalised point, else null. */
export function hitTest(p: Point, boxes: readonly { id: DetectionId; box: BoundingBox }[]): DetectionId | null;
/** Android: among "WxH" strings, the smallest **4:3** size (±2 %) whose long side ≥ minLongSide; if none, the
 *  largest 4:3 size; if no 4:3 size, the smallest size with long side ≥ minLongSide; undefined when the list is
 *  empty or unparsable (→ camera default). CameraX prefers 4:3 for the preview, so 4:3 keeps photo and preview
 *  aspects equal. */
export function pickPictureSize(sizes: readonly string[], minLongSide: number): string | undefined;
/** false when one is landscape and the other portrait (aspect on opposite sides of 1, ±5 %). Android bakes the
 *  last known physical orientation into the photo (OrientationEventListener keeps it when the phone lies flat),
 *  so a portrait-locked preview can receive a landscape photo; such a live snapshot is skipped. The 180° case
 *  cannot be detected (known limit, R3). */
export function orientationMatches(image: Size, view: Size): boolean;

// tracker.ts — RG_02
export interface Track { id: DetectionId; box: BoundingBox; hits: number; misses: number }
export interface TrackUpdate { tracks: Track[]; /** track id per input box, same order */ assigned: DetectionId[]; removed: DetectionId[] }
/** Greedy one-to-one matching by descending IoU (≥ VISION.trackIou). Matched: box replaced, hits+1, misses=0.
 *  Unmatched box: new track (hits 1). Unmatched track: misses+1, removed when misses > maxMisses (default 1). */
export function updateTracks(tracks: readonly Track[], boxes: readonly BoundingBox[], newId: () => DetectionId,
  opts?: { iou?: number; maxMisses?: number }): TrackUpdate;

// live.ts — adaptive live loop (D9), pure
export interface LiveTuning { intervalMs: number; segMaxSide: number; failures: number; disabled: boolean }
export const INITIAL_LIVE_TUNING: LiveTuning;   // { intervalMs: 2500, segMaxSide: 256, failures: 0, disabled: false }
/** After each tick. 'ok' with cycleMs > slowCycleMs → intervalMs × 1.5 (≤ maxIntervalMs) and, once intervalMs is at
 *  its max, segMaxSide → exploreMin; 'ok' with cycleMs < slowCycleMs / 2 → intervalMs × 0.8 (≥ intervalMs default);
 *  'ok' and 'skipped' reset failures; 'failed' (thrown capture or ingest) → failures + 1, disabled when
 *  failures ≥ maxFailures. A slow cycle is never a failure. */
export function adaptLive(t: LiveTuning, tick: { outcome: 'ok' | 'skipped' | 'failed'; cycleMs: number }): LiveTuning;

// detections.ts
/** RG_03: NMS on tight boxes (score = areaFrac), keeps at most VISION.maxBoxes (largest), then maps to Detection
 *  (source 'segmentation'). `truncated` is true when boxes were dropped by the cap. */
export function toDetections(seg: SegmentationResult, newId: () => DetectionId): { detections: Detection[]; truncated: boolean };
export function wholeImageDetection(id: DetectionId): Detection;        // box {0,0,1,1}, source 'whole_image'
/** Pixel-square box centred on `center`; side = median long side of `others` (default 18 % of the image's short side). */
export function manualDetection(id: DetectionId, center: Point, image: Size, others: readonly Detection[]): Detection;
```

`src/domain/vision/testing/synth.ts` (not a test file): `makeScene({ width, height, background, rects, noise, seed })`
→ `Uint8Array` RGBA; backgrounds `'white' | 'grey' | 'wood' | 'gradient' | 'checker'`; rect = `{ x, y, w, h, rgb,
shadow? }`; seeded PRNG (mulberry32) so tests are deterministic.

### 4.5 Pile logic + scan services (WP3)

```ts
// src/domain/pile/thresholds.ts — RG_04 + D5
export const THRESHOLDS: { accepted: 0.8; review: 0.5 };
export const SCORE_CALIBRATION: readonly (readonly [raw: number, confidence: number])[];
//   [[0, 0], [0.5, 0.5], [0.65, 0.8], [0.9, 0.99], [1, 0.99]]
export const AMBIGUITY = { margin: 0.05, cap: 0.79, minBoxScore: 0.5 } as const;
export function calibrateScore(raw: number): number;                    // piecewise-linear, monotonic, clamped 0..0.99
export function confidenceLevel(confidence: number): ConfidenceLevel;   // ≥ 0.8 accepted · ≥ 0.5 review · else unknown
/** confidence = 1 if partConfirmed; 0 if status ≠ 'identified' or chosen < 0; else candidate.confidence, capped at
 *  AMBIGUITY.cap when (top-2 rawScore within margin of top-1 and chosen = 0) or boxScore < minBoxScore. */
export function evaluatePiece(p: Pick<IdentifiedPiece, 'identification' | 'chosen' | 'partConfirmed'>):
  { confidence: number; level: ConfidenceLevel };

// src/domain/pile/brickognizeParse.ts
export function isPseudoItem(id: string): boolean;                      // e.g. '3001special'
/** Never throws. Sorts items by score, drops pseudo-items, keeps ≤ 3, computes Candidate.confidence.
 *  No item → status 'empty'. Not an object / no `items` array → status 'unavailable', error 'server'.
 *  A missing or malformed `colors` array → colors [] (the `/predict/*` routes are "Legacy" and `colors` is not in
 *  their OpenAPI schema; colour then comes from the local estimate). */
export function parseBrickognizeResponse(json: unknown): Identification;

// src/domain/pile/colorFusion.ts — D6, RG_06
export function fuseColor(input: { brickognize: readonly ColorCandidate[]; lab: Lab | null; palette: Palette }): ColorEstimate;
//   bk    = Brickognize colours mapped through palette.byBricklinkId (unmapped dropped), best first
//   local = lab ? nearestColors(lab, palette.colors, { allowed: COMMON_OPAQUE_COLOR_IDS, k: 3 }) : []
//   1. bk[0] with score ≥ 0.5 → colorId = bk[0]; source 'brickognize';
//      reliable = bk[0].isTrans || score ≥ 0.8 || local contains colorId || (lab === null && score ≥ 0.7)
//   2. bk[0] with score < 0.5 → colorId = bk[0]; reliable = false
//   3. no bk, local[0] → colorId = local[0]; source 'local'; reliable = false
//   4. nothing → colorId null; source 'none'; reliable = false
//   alternatives = distinct [bk…, local…] minus colorId, at most 5

// src/domain/pile/grouping.ts — RG_05, RG_06, RG_03
/** Deterministic. A provisional part (source 'brickognize') counts as a known part; the pipeline sets it as soon
 *  as Brickognize answers, so `part === null` only means "not identified yet". Rules, first match wins, per piece:
 *   level 'unknown' (incl. pending/empty/unavailable) or part === null → own group 'u:<id>' (kind unknown)
 *   detection.partial && !partialConfirmed                        → own group 'x:<id>' (kind partial)
 *   color.colorId === null || !color.reliable                     → 'c:<partId>|<colorId ?? "?">' (color_to_confirm)
 *   else                                                          → 'p:<partId>|<colorId>' (ok)
 *  Order: ok (count desc, name asc), color_to_confirm, partial, unknown (top-to-bottom of the image).
 *  `name` = partLabel(part.name) (French display label, §4.7). */
export function groupPieces(pieces: readonly IdentifiedPiece[]): PileGroup[];
/** Union of the members' candidates by bricklinkId (max rawScore, best first, at most 5) — what the chooser of a
 *  grouped line offers. */
export function lineCandidates(pieces: readonly IdentifiedPiece[], detectionIds: readonly DetectionId[]): Candidate[];

// src/domain/pile/review.ts — EX_06, RG_07, RG_09, RG_10 (all pure, return new objects)
export function createReview(pieces: readonly IdentifiedPiece[]): ReviewState;
export function reviewLines(state: ReviewState, sessionAdded?: Readonly<Record<string, number>>): ReviewLine[];
export function reviewSummary(state: ReviewState): ReviewSummary;
export function setLineQuantity(state: ReviewState, key: string, quantity: number): ReviewState;   // clamp 0..9999; 0 → removed
export function removeLine(state: ReviewState, key: string): ReviewState;
export function restoreLine(state: ReviewState, key: string): ReviewState;
/** Sets { colorId, reliable: true, source: 'user' } on every member; the line re-keys and merges with an existing
 *  'p:' line of the same key (quantity overrides of both are dropped → merged count). */
export function setLineColor(state: ReviewState, key: string, colorId: ColorId): ReviewState;
/** « Tout confirmer »: setLineColor(key, current colorId) for every color_to_confirm line whose colorId is not null. */
export function confirmAllColors(state: ReviewState): ReviewState;
export function confirmPartial(state: ReviewState, key: string): ReviewState;
/** Explicit choice (RG_04 "inconnue" / "à vérifier") applied to EVERY member of a line (or to one detection when
 *  the list has one id): the candidate is appended to a member's candidates when absent; chosen = its index,
 *  part = `part`, partConfirmed = true (confidence 1, level 'accepted'). The line re-keys and may merge. */
export function chooseCandidate(state: ReviewState, detectionIds: readonly DetectionId[], candidate: Candidate,
  part: CatalogPart): ReviewState;
/** One delta per addable line. */
export function toDeltas(state: ReviewState, listId: ListId): ItemDelta[];

// src/domain/pile/calibration.ts — EX_10 / EX_11
/** One line per entry: `<partId>[/<colorId>] [x<qty>]`, e.g. `3001/4 x3`, `3020/0`, `3062b x2`.
 *  Separators: newline, ';' or ','. Quantity defaults to 1. Duplicate keys are summed. */
export function parseExpected(text: string): { lines: CountedLine[]; errors: { line: number; text: string }[] };
/** Counts pieces of 'ok' and 'color_to_confirm' groups (colorId null when not reliable). */
export function countDetected(pieces: readonly IdentifiedPiece[]): CountedLine[];
/** An expected line with colorId null matches any colour of that part. Empty denominators give 0. */
export function computeMetrics(detected: readonly CountedLine[], expected: readonly CountedLine[]): CalibrationMetrics;
export function buildCalibrationSession(input: { id: string; createdAt: string; platform: string; appVersion: string;
  result: ScanResult; expected: readonly CountedLine[] }): CalibrationSession;
```

Interpretation fixed here (to be reflected in the specs, §8.4): 'accepted' **and** 'review' pieces are counted in
their `PartID+ColorID` group and are added by « Ajouter »; the orange `ConfidenceBadge` of a line is pressable and
opens the top-candidate chooser (`lineCandidates`), and the footer says « dont {n} à vérifier »
(`ReviewSummary.toVerify`), so pressing « Ajouter » is an informed confirmation. 'unknown' pieces are never added
without `chooseCandidate`; 'partial' pieces never without `confirmPartial`; a `color_to_confirm` line blocks the
add until its colour is confirmed (one tap « Confirmer {couleur} », or « Tout confirmer »), changed, or the line
removed.

```ts
// src/services/imaging.ts — expo-image-manipulator + expo-file-system + upng-js (D1). None of these reject.
// (verify) on device that takePictureAsync's width/height are post-rotation (no skipProcessing).
/** Captures only. Returns the photo itself when its long side ≤ maxSide (no re-encode); otherwise ONE manipulator
 *  context resizes it to maxSide and saves JPEG 0.85. Live snapshots never call this: the photo is the frame. */
export function prepareWorkImage(photo: ScanFrame, maxSide: number): Promise<Result<ScanFrame>>;
/** ONE manipulator context on `frame.uri`: resize (long side ≤ maxSide) → PNG → File.bytes() →
 *  new Uint8Array(UPNG.toRGBA8(UPNG.decode(bytes))[0]). Deletes the PNG. decode errors (corrupt/empty file) →
 *  err('unknown'), never a throw. */
export function readThumbnailRgba(frame: ScanFrame, maxSide: number): Promise<Result<{ rgba: Uint8Array; width: number; height: number }>>;
/** JPEG crop of `box` from `frame` (the original photo in live mode), long side = VISION.crop.outSide.
 *  err('invalid', scan.tooSmall) when the source rect is smaller than VISION.crop.minSourceSide. */
export function cropForIdentification(frame: ScanFrame, box: BoundingBox): Promise<Result<{ uri: string }>>;
export function wholeForIdentification(frame: ScanFrame): Promise<Result<{ uri: string }>>;   // long side VISION.wholeImageSide
export function deleteTempFiles(uris: readonly string[]): Promise<void>;

// src/services/brickognize.ts — the only file that knows the Brickognize HTTP API (D4)
/** POST {env.brickognizeUrl}/predict/parts/?predict_color=true&top_k_items=5&top_k_colors=3&min_similarity_items=0.25
 *  multipart field `query_image` (image/jpeg). Never rejects.
 *  429 → wait max(250 ms, x-retry-in | retry-after) + jitter, up to maxRetries; network error → one retry;
 *  budget exhausted, timeout, 5xx, 415 or retries exhausted → { status: 'unavailable', error }. */
export function identifyImage(uri: string, signal?: AbortSignal): Promise<Identification>;

// src/services/scanPipeline.ts — orchestration, never rejects
export interface SegmentedPhoto { frame: ScanFrame; background: BackgroundQuality; detections: Detection[];
  wholeImage: boolean; truncated: boolean; prepareMs: number; segmentMs: number }
/** Capture path: prepareWorkImage(photo, VISION.workMaxSide) → readThumbnailRgba(segMaxSide.inventory) →
 *  segmentPileAsync (yielding) → toDetections. When there is no box or the background is 'patterned':
 *  detections = [wholeImageDetection], wholeImage = true. */
export function segmentPhoto(photo: ScanFrame, newId: () => DetectionId, signal?: AbortSignal): Promise<Result<SegmentedPhoto>>;
/** Live path: frame = photo (no re-encode) → readThumbnailRgba(segMaxSide) → segmentPileAsync → raw boxes
 *  (no whole-image fallback; tracking is done by the store). */
export function segmentLive(photo: ScanFrame, segMaxSide: number): Promise<Result<{ seg: SegmentationResult; ms: number }>>;
/** For each detection: crop from `frame` → identifyImage (pool of VISION.brickognize.concurrency) → fuseColor →
 *  part = provisionalPart(top candidate) (D7, immediate) → evaluatePiece → onPiece (cropUri set).
 *  Then ONE catalog.resolveCandidates() call for all distinct chosen candidates → resolved parts swapped in →
 *  onPiece again. Whole-image detections: the box is replaced by Brickognize's bounding_box when boxScore ≥ 0.5.
 *  After `signal` aborts, no onPiece is called and in-flight requests are cancelled.
 *  mode 'explore' writes nothing but the catalogue cache (EX_04). */
export function identifyDetections(frame: ScanFrame, detections: readonly Detection[], opts: { signal?: AbortSignal;
  onPiece: (piece: IdentifiedPiece) => void }): Promise<{ pieces: IdentifiedPiece[]; identifyMs: number; catalogMs: number; calls: number }>;

// src/state/scanStore.ts — scan session shared by ScannerScreen, ReviewScreen, PartScreen and CalibrationScreen
export interface ScanState {
  /** New id at every capture / freeze / resume; results carrying an older id are dropped. */
  scanId: string;
  mode: ScanMode;
  /** live: camera preview (+ boxes of the last snapshot) · analyzing: capture being prepared/segmented (no box
   *  yet) · frozen: still shown; entered as soon as boxes exist, identification continues progressively */
  phase: 'live' | 'analyzing' | 'frozen';
  /** Image the boxes refer to (live snapshot or capture); null before the first snapshot. */
  frame: ScanFrame | null;
  pieces: IdentifiedPiece[];
  selectedId: DetectionId | null;
  notice: ScanNotice | null;
  /** false after the automatic fallback (D9), until the next app start. */
  liveOk: boolean;
  review: ReviewState | null;
  /** Last completed Inventorier capture, kept for Calibration (EX_10). */
  lastResult: ScanResult | null;
  /** itemKey → quantity added since app start (RG_09). */
  sessionAdded: Record<string, number>;
}
export const scanStore: Store<ScanState>;
export const scanActions: {
  /** Does not reset frame/pieces (mockups §2 "bascule fluide"). */
  setMode(mode: ScanMode): void;
  /** Explorer/Inventorier live tick, never rejects. Returns 'skipped' (and changes nothing) unless phase ===
   *  'live', or when !orientationMatches(photo, viewSize) (Android rotation, R3), or when the scene is 'patterned'.
   *  Else tracks boxes (RG_02); in 'explore' mode crops (from the photo) and identifies tracks with hits ≥
   *  VISION.live.stableHits not yet identified or in flight; in 'inventory' mode only segments. 'failed' only on
   *  a thrown/err result of segmentLive. Deletes the previous snapshot photo (the current one stays as `frame`,
   *  for freeze), a skipped photo, and the crops of removed tracks. */
  ingestLiveSnapshot(photo: ScanFrame, viewSize: Size, segMaxSide: number): Promise<'ok' | 'skipped' | 'failed'>;
  /** Shutter (EX_05) or manual « Analyser »: new scanId, phase analyzing → frozen as soon as boxes exist, then
   *  progressive identification. In 'inventory' mode stores lastResult when identification completes.
   *  On failure: phase 'live' + notice. */
  capture(photo: ScanFrame): Promise<void>;
  /** live → frozen on the current snapshot (Explorer: a box or drawer line was tapped). If `selectId` has no
   *  identification done or in flight (e.g. a track seen once), it is identified now with progressive updates.
   *  Never called in 'inventory' mode (a live box tap does nothing there). */
  freeze(selectId?: DetectionId): void;
  /** → live, always allowed (also during 'analyzing'): aborts in-flight identification (AbortController), bumps
   *  scanId, deletes the crops, clears frame, pieces, selection, notice and review; keeps sessionAdded and
   *  lastResult. */
  resume(): void;
  /** Called by useLiveLoop when adaptLive() returns disabled: liveOk = false, notice 'live_unavailable'. */
  reportLiveFailure(): void;
  /** EX_09: re-identifies pieces with status 'unavailable' and pieces stuck in 'pending' with no request in
   *  flight (the store keeps an in-flight set of detection ids). */
  retryUnavailable(): Promise<void>;
  addManualBox(point: Point): Promise<void>;           // frozen only; identifies the new box
  removePiece(id: DetectionId): void;
  select(id: DetectionId | null): void;
  /** Resolves `candidate` through catalog.resolveCandidates, then applies review.chooseCandidate to the detections
   *  of `target` (a single box, or every member of a drawer/review line); on review.pieces when a review is open,
   *  else on pieces. */
  chooseCandidate(target: { detectionId: DetectionId } | { groupKey: string }, candidate: Candidate): Promise<void>;
  /** review = createReview(pieces). Catalogue results arriving after this update `pieces` only, never `review`
   *  (group keys must stay stable while the user edits); lines added with a provisional part are reconciled
   *  later by catalog.hydrateParts on unpushed rows (D7). */
  startReview(): void;
  updateReview(fn: (s: ReviewState) => ReviewState): void;
  /** RG_08 via inventoryRepo.applyDeltas(toDeltas(review, listId)); setLastListId; updates sessionAdded; clears
   *  review and calls resume(). `skipped` = summary.unknown + summary.partial. `undo` applies the inverse deltas
   *  and reverts sessionAdded (RG_09). */
  commitReview(listId: ListId): Promise<Result<{ added: number; skipped: number; undo: () => Promise<void> }>>;
};
```

`src/i18n/fr/scan.ts` (WP3) holds the French messages produced by WP3 services (`tooSmall: « Pièce trop petite —
rapprochez-vous »`, `noCrop`, `liveUnavailable` …); WP4 displays them.

Pipeline timing target for a 20-piece pile on Wi-Fi (capture path; to be confirmed by device script I2):
capture ≈ 0.5 s; prepare (no re-encode when the photo is ≤ 1920 px) + thumbnail decode ≈ 0.1–0.2 s; segmentation
≈ 0.6–1.2 s on a mid-range Android (jitless proxy 442 ms at 320 px on a desktop), yielding between stages; 20 crops
+ 20 Brickognize calls (pool of 4) ≈ 2 s; catalogue: warm 0.3 s, cold ≈ 1.2 s + 1.1 s per id that needs the
per-id BrickLink fallback (at most 5 per request, the rest re-requested), i.e. **up to ≈ 20 s for a pile of 15
mould-variant ids** — invisible to the user because provisional parts (name, image) are shown immediately and
swapped when resolved. Boxes appear after ≈ 1.5–2 s and fill in progressively.

Live tick target (Explorer): capture ≈ 0.3–0.6 s + thumbnail ≈ 0.1 s + segmentation at 256 px ≈ 0.4–0.8 s; when a
cycle exceeds `slowCycleMs` the loop stretches its interval and drops to 192 px (`adaptLive`) instead of turning
itself off.

### 4.6 Scanner & review UI (WP4) — `src/screens/scanner/*`

Files: `ScannerScreen.tsx`, `CameraPermission.tsx`, `BoxOverlay.tsx`, `PileDrawer.tsx`, `ScanControls.tsx`
(mode switch + shutter), `CandidateChooser.tsx`, `useLiveLoop.ts`, `useCamera.ts`, `ReviewScreen.tsx`,
`src/i18n/fr/scanner.ts`.

- **Permission (EX_08, B4)**: before the system prompt, a sheet explains the camera use and that images are sent
  to Brickognize; « Autoriser la caméra » → `requestPermission()`; « Plus tard » leaves an explanatory empty state
  with the same button; when `canAskAgain === false` the button is « Ouvrir les réglages » (`Linking.openSettings()`).
- **Camera**: `<CameraView facing="back" enableTorch={torch} autofocus={focusLocked ? 'on' : 'off'}
  pictureSize={size} animateShutter={false} onCameraReady onMountError onLayout />`, mounted only while the tab is
  focused (`useIsFocused` imported from **`expo-router`**; `@react-navigation/native` is not a top-level
  dependency) and the app is active. `size` per D3: iOS `"1920x1080"`; Android = kv `camera.pictureSize` when
  present (passed on the first render, so the camera binds once), else `pickPictureSize(await
  getAvailablePictureSizesAsync(), 1920)` after the first `onCameraReady`, then written to kv. `useCamera` queries
  sizes at most once per install: a second `onCameraReady` (caused by the rebind) never re-queries. The view size
  from `onLayout` is passed to `ingestLiveSnapshot` and the overlay. Torch initial value = `settings.torchOnLaunch`. Long-press on the preview toggles focus lock (lock icon + toast;
  best effort on Android). `onMountError` → `ErrorState` with retry.
- **Live loop (`useLiveLoop`)**: enabled when `settings.liveExplorer && liveOk && phase === 'live'` and camera
  ready; single-flight; keeps a `LiveTuning` (starts at `INITIAL_LIVE_TUNING`, reset at app start);
  `takePictureAsync({ quality: VISION.picture.liveQuality, shutterSound: false })` →
  `scanActions.ingestLiveSnapshot(photo, viewSize, tuning.segMaxSide)`; a thrown capture is outcome 'failed';
  `tuning = adaptLive(tuning, { outcome, cycleMs })`; next tick `max(tuning.intervalMs − elapsed, 500 ms)` later;
  `tuning.disabled` → `reportLiveFailure()`. When live is off, Explorer shows an « Analyser » button that calls
  `capture`. A discreet hint « Tenez le téléphone en portrait » shows after 3 consecutive 'skipped' outcomes.
- **Overlay (`BoxOverlay`)**: absolutely positioned `View`s. Live: `coverTransform(frame, viewSize)`; frozen: the
  still is an `expo-image` with `contentFit="contain"` and boxes use `containTransform`. Each box: white 3 px outer
  + status-colour 2 px inner border, label chip « 2 × 4 Rouge · 92 % ✓ » (short label = `parseDimensions(name)?.label
  ?? name`, colour = `colorLabel`), status icon; pending = grey with spinner; unavailable = grey + cloud-offline
  icon; partial = dashed + « pièce coupée »; suspectMerged = « plusieurs pièces ? ». Explorer: tap a box →
  `freeze(id)` (if live; identifies it when needed) + `select(id)`, then `routes.part(part.partId, color.colorId)`
  once a part is known (EX_02), otherwise the `CandidateChooser` (spinner « Identification… » while pending).
  Inventorier live: boxes are a count preview, a tap does nothing. Tap on empty space of a frozen still →
  `addManualBox`. Long-press a box → remove.
- **Android back** (`BackHandler` on ScannerScreen while focused): drawer expanded → collapse; frozen or
  analyzing → `resume()`; otherwise default behaviour.
- **Drawer (`PileDrawer`, EX_03, B2)**: `Animated` + `PanResponder`, three snap heights (collapsed header only /
  45 % / 85 %), also toggled by tapping the header (accessible alternative to dragging). Header: « {n} pièces
  détectées » (RG_01: hidden when n < 2; « ≈ » prefix, RG_07). In live Inventorier the drawer shows the count
  header only (no rows: pieces are not identified yet). Otherwise rows = `groupPieces(pieces)`: thumbnail, name,
  colour dot, ×count, `ConfidenceBadge`; tap → select + highlight the group's boxes + open the fiche; an orange
  ('review') badge is pressable and opens `CandidateChooser` for the line (`lineCandidates`, image + name + score;
  choice → `chooseCandidate({ groupKey }, candidate)`).
- **CandidateChooser**: header = the piece's crop (`cropUri`) next to the candidates, so the user compares the real
  piece with the catalogue images; « Aucune de ces pièces » closes it.
- **Controls**: `SegmentedControl` Explorer | Inventorier (thumb zone); Inventorier shows the yellow shutter
  (`takePictureAsync({ quality: VISION.picture.captureQuality })` → `capture`), Explorer shows a scanning indicator
  (or « Analyser »). Analyzing and frozen states: « Reprendre » (→ `resume`, always enabled) and, in Inventorier
  frozen, primary « Valider ({n}) » → `startReview()` + `router.push(routes.review)`. Top bar (read-only zone): torch, focus-lock state, settings
  (`routes.settings`); when `settings.calibration`, a flask button → `routes.calibration`.
- **Notices**: `Banner` above the controls — `patterned_background` « Étalez les pièces sur une surface unie, sans
  qu'elles se touchent. », `no_piece` « Pointez la caméra vers vos briques », `too_many`, `identification_unavailable`
  « Identification indisponible » + « Réessayer » (`retryUnavailable`, EX_09), `live_unavailable`.
- **ReviewScreen (B3, EX_06/07)**: when `scanStore.review === null` (fast refresh, restored route) →
  `router.replace(routes.scanner)`. `Screen` title « Valider la pile », `Banner` warn « ≈ comptage approximatif —
  ajustez si besoin » (RG_07), RG_09 `Banner` when a line has `alreadyAdded > 0` (« Déjà ajouté depuis cette
  session : {n} référence(s) »). One row per `ReviewLine`: thumbnail = **the piece's crop** (`cropUri`) for
  unknown / partial / color_to_confirm rows, `PartImage` otherwise; « 3× Brique 2 × 4 Rouge »; tappable `ColorDot`
  (→ `ColorPickerSheet` with `suggested = color.alternatives`, `referenceUri = cropUri`, `measuredHex` from the
  first member's `detection.rgb`); `ConfidenceBadge` (orange badge pressable → `CandidateChooser` for the line);
  `QuantityStepper`; remove; row tap → fiche. `color_to_confirm` rows: « Couleur à confirmer » + primary
  « Confirmer {couleur} » (= `setLineColor(key, current colorId)`, absent when colorId is null) + « Changer »;
  « Tout confirmer » above the list when ≥ 3 such lines (`confirmAllColors`). `partial` rows: « Pièce coupée » +
  « Compter cette pièce ». `unknown` rows: « Inconnue » + « Choisir » (`CandidateChooser`) or « Identification
  indisponible » + « Réessayer ». All lines removed → `EmptyState` « Aucune pièce à ajouter » + « Reprendre le
  scan ». Footer: list selector (`ListPickerSheet`, default `getLastListId()`), primary « Ajouter {n} pièces à
  {liste} » with sub-labels « dont {toVerify} à vérifier » and « {unknown + partial} pièce(s) non identifiée(s) ne
  seront pas ajoutées » when non-zero; disabled with reason when `!summary.canAdd`. On success:
  `feedback.success()`, visual check animation, `router.back()`, `showSnackbar({ text: « {n} pièces ajoutées à
  {liste} » or « {n} ajoutées · {k} ignorées » when skipped > 0, actionLabel: « Annuler », onAction: undo,
  durationMs: UNDO_MS })`. Sheets (`ListPickerSheet`, `ColorPickerSheet`) are closed before any snackbar.

### 4.7 Catalogue (WP5)

```ts
// src/services/catalog.ts — local SQLite first, then catalog-proxy (§6.2). The proxy is called through
// supabase.functions.invoke('catalog-proxy', { body }) (works for guests: only the publishable key is sent).
// Circuit breaker: after a proxy failure (network, 401, 404, 5xx) skip the proxy for 5 minutes.
// Calls to the proxy are serialised (one in flight).

/** Never rejects. Memoised. Source: catalog_colors / catalog_categories when non-empty, else the bundled
 *  src/data/seed/palette.json (not copied into the tables). Triggers a background refresh ({ op: 'palette' })
 *  when meta.palette_fetched_at is missing or older than 30 days; the refresh writes the tables (withWrite),
 *  replaces the memo and calls notify('catalog').
 *  byBricklinkId is built deterministically: on a collision the LOWEST Rebrickable id wins (live palette
 *  2026-11-14: BrickLink 77 → 148 Pearl Dark Gray / 1103 Pearl Titanium, BrickLink 72 → 313 Maersk Blue / 1051
 *  Pastel Blue → 148 and 313 win). */
export function getPalette(): Promise<Palette>;
/** Pure (exported for tests): builds the Palette maps from colours + categories. */
export function buildPalette(colors: readonly CatalogColor[], categories: readonly CatalogCategory[]): Palette;

/** D7. Never rejects; every input id has an entry in the result.
 *  1. catalog_bl_map hit younger than 90 days (7 days for a negative entry) → local part.
 *  2. Missing ids → { op: 'parts', id_type: 'bricklink', ids } in chunks of 50; ids answered 'pending' are
 *     re-requested up to 3 more times, 1.5 s apart (the proxy resolves 5 fallback ids per request).
 *     Found → upsert catalog_parts + catalog_bl_map.
 *  3. 'not_found' → provisional part with resolution 'not_found'; proxy unavailable or still 'pending' →
 *     provisional part with resolution 'pending' (`provisionalPart(candidate, resolution)`), stored in
 *     catalog_parts unless a row with that id already exists (an existing 'pending' row may become 'not_found'). */
export function resolveCandidates(
  candidates: readonly Pick<Candidate, 'bricklinkId' | 'name' | 'imageUrl'>[]): Promise<Map<BricklinkId, CatalogPart>>;

/** Local only. */
export function getPart(partId: PartId): Promise<CatalogPart | null>;

/** Never rejects; serialised with the other proxy calls; at most one run in flight. Called by InventoryScreen on
 *  load and by sync before building a batch when items are held back (D7).
 *  a) partIds without a local row → { op: 'parts', id_type: 'rebrickable', ids } (chunks of 50); ids answered
 *     'not_found' get a local placeholder row (source 'brickognize', resolution 'not_found', name = partId) that
 *     acts as a 7-day negative cache, so the proxy is not asked again on every load;
 *  b) parts with resolution 'pending' (at most once per 10 minutes per part) → re-resolved by BrickLink id.
 *     Found with the same id → row upgraded. Found with another part_num → inventoryRepo.renamePart(oldId,
 *     newId), then the catalogue row is replaced. Explicit 'not_found' → resolution 'not_found' (final: the items
 *     become syncable under that id). Pending parts are never synced (D7), so renamePart only ever moves
 *     unpushed rows (base_quantity 0) and is safe across devices;
 *  c) inventory rows whose (part, colour) has no catalog_part_colors row and whose part is resolved →
 *     { op: 'part_colors', part_ids } (≤ 5 parts per call, ≤ 25 parts per app session, most recently updated
 *     rows first); writes one catalog_part_colors row per colour returned.
 *  Calls notify('catalog') when something changed. */
export function hydrateParts(partIds: readonly PartId[]): Promise<void>;

/** EX_12 / EX_14. Local catalog_part_colors younger than 30 days answers `partColor` without network;
 *  sets pages always come from the proxy (cached server-side). Provisional part → err('not_found'). */
export function getPartDetail(partId: PartId, colorId: ColorId, page?: number): Promise<Result<PartDetail>>;
/** D15. Quantity of the part+colour in one set (spares excluded); null when the set does not list it. */
export function getSetQuantity(setNum: string, partId: PartId, colorId: ColorId): Promise<Result<number | null>>;

// src/hooks/useCatalog.ts
export function usePalette(): Palette | null;                           // null only during the first load
export function usePart(partId: PartId | null): AsyncState<CatalogPart | null>;   // re-reads on 'catalog'
export function usePartDetail(partId: PartId | null, colorId: ColorId | null): AsyncState<PartDetail>;

// src/domain/catalog/partInfo.ts (pure; imports only types and src/i18n/fr/catalog.ts)
/** French display label (D18): leading words translated through PART_WORDS_FR (longest match first, case kept for
 *  the rest), ' x ' → ' × '. 'Brick 2 x 4' → 'Brique 2 × 4', 'Plate Round 1 x 1' → 'Plaque ronde 1 × 1',
 *  'Technic Pin' → 'Technic Pin' (no entry → original name). */
export function partLabel(name: string): string;
/** CATEGORY_NAMES_FR[id] ?? fallback (Rebrickable name) ?? null. */
export function categoryLabel(id: number | null, fallback: string | null): string | null;
/** D7 provisional part from a Brickognize candidate: partId = bricklinkId, name, imageUrl, categoryId null,
 *  bricklinkIds [bricklinkId], legoIds [], printOf null, years null, source 'brickognize'. */
export function provisionalPart(c: Pick<Candidate, 'bricklinkId' | 'name' | 'imageUrl'>,
  resolution: 'pending' | 'not_found'): CatalogPart;
/** /(\d+(?:\/\d+)?)\s*x\s*(\d+(?:\/\d+)?)(?:\s*x\s*(\d+(?:\s\d+\/\d+|\/\d+)?))?/ on the part name.
 *  'Brick 2 x 4' → { label: '2 × 4', studsX: '2', studsY: '4', height: null }; no match → null (UI shows « — »). */
export function parseDimensions(name: string): PartDimensions | null;
/** LEGO design id: the legoIds entry equal to the numeric root of partId, else legoIds[0], else partId. */
export function designId(part: Pick<CatalogPart, 'partId' | 'legoIds'>): string;
/** EX_13: https://www.lego.com/fr-fr/pick-and-build/pick-a-brick?query=<id>, id = last element id when known,
 *  else designId(part). The query value is URI-encoded. */
export function pickABrickUrl(part: Pick<CatalogPart, 'partId' | 'legoIds'>, elementIds?: readonly string[]): string;
/** EX_14 client-side filter over loaded pages: case/diacritics-insensitive match on name or set number. */
export function filterSets(sets: readonly SetRef[], filter: { query: string; year: number | null }): SetRef[];
export function setYears(sets: readonly SetRef[]): number[];             // distinct, descending
```

`catalogRepo.ts` (internal to WP5) reads/writes the `catalog_*` tables of §4.2 (writes through `withWrite`).
`src/data/seed/palette.json` = `{ "generatedAt": "...", "colors": CatalogColor[], "categories": CatalogCategory[] }`
and nothing else (no request/response metadata), generated by `scripts/gen-palette.mjs` from
`GET /api/v3/lego/colors/?page_size=1000` and `/part_categories/?page_size=200` (two read-only calls,
`Authorization: key $REBRICKABLE_API_KEY` taken from the environment, never printed; skip ids `-1` and `9999`;
`bricklinkId = external_ids.BrickLink.ext_ids[0] ?? null`).

`src/i18n/fr/catalog.ts` (WP5): `CATEGORY_NAMES_FR: Readonly<Record<number, string>>` — all 76 Rebrickable
categories of the seed, keyed by the ids found in `palette.json`, translated by WP5 (e.g. 11 Bricks →
« Briques », Plates → « Plaques », Tiles → « Tuiles », Bricks Sloped → « Briques inclinées »); `PART_WORDS_FR: readonly (readonly [en: string, fr:
string])[]` — about 25 leading-word entries (Brick → Brique, Plate → Plaque, Tile → Tuile, Slope → Pente,
Wedge → Coin, Round → rond(e), Panel → Panneau, Bracket → Équerre, Hinge → Charnière, Wheel → Roue, Tyre → Pneu,
Window → Fenêtre, Door → Porte, Arch → Arche, Cylinder → Cylindre, Cone → Cône, Dish → Parabole, Baseplate →
Plaque de base, Minifig → Minifig, Technic → Technic …); untranslated words stay in English.

**PartScreen (C1)**, a card screen with a back chevron, route params `partId`, `colorId` ('' = unknown): header
image (`partColor.imageUrl ?? part.imageUrl`), title = `partLabel(name)`, « Nom officiel : {name} » underneath,
`ColorDot` + « {colorLabel} · #{hex} » (tap → `ColorPickerSheet` to change the colour shown); card Design ID /
Element ID (`elementIds` joined, « — » if none) / Catégorie (`categoryLabel`) / Dimensions; primary « Acheter sur
LEGO ↗ » (`Linking.openURL(pickABrickUrl(...))`, a11y hint « Ouvre lego.com dans le navigateur », sub-label
« Recherche sur Pick a Brick — disponibilité non garantie »); secondary « + Ajouter à une liste »
(`ListPickerSheet` → on select: close the sheet, then `inventoryRepo.applyDeltas([+1])` + undo snackbar; disabled
without a colour); section « Sets compatibles » ({total}): search field + year chips, « {loaded} sur {total} sets
chargés » next to the filter whenever pages remain, rows visual / number / name / year, tap a row → quantity
« ×16 » loaded once (`getSetQuantity`), « Charger plus » for the next page, kept visible while a filter is active;
when a filter change leaves the list empty and pages remain, the next page is loaded automatically once (one call
per filter change). States: skeleton while
loading; provisional part → `Banner` « Pièce non référencée dans le catalogue : informations limitées »;
`partColor.found === false` → « Cette pièce n'est pas référencée dans cette couleur »; error → `ErrorState` with
retry, identity block still shown from the local cache (RT_01); no colour → « Choisissez une couleur pour voir les
sets ».

### 4.8 Inventory, lists, export (WP6)

```ts
// src/data/inventoryRepo.ts — the only writer of user changes to `lists` / `items`.
// Every mutation = ONE withWrite callback: read the affected rows on `tx` → pure function (mergeDeltas /
// validateListName) → write the result on `tx`; then notify('inventory' and/or 'lists', 'mutation'). No SQL
// re-implementation of the merge rules: the tested function is the one that runs.
// Every list mutation (create, rename, delete-as-tombstone) sets dirty = 1 explicitly.
export const DEFAULT_LIST_NAME = 'Mon inventaire';
/** Returns a live list, creating DEFAULT_LIST_NAME (dirty = 1) when none exists. Same-name lists created on
 *  several devices are mapped by name at the first sync of each device (§4.10). */
export function ensureDefaultList(): Promise<List>;
/** Calls ensureDefaultList() first, so a brand-new guest or a freshly wiped device always has one list.
 *  Lists with deleted = 0, by created_at; counts over items with quantity > 0. */
export function getLists(): Promise<ListSummary[]>;
/** Name trimmed, 1–60 chars, unique case-insensitively among live lists → else err('invalid', message). */
export function createList(name: string): Promise<Result<List>>;
export function renameList(id: ListId, name: string): Promise<Result<void>>;
/** Refused (err 'invalid') for the last live list. Removes the list's items locally; the list row becomes a
 *  dirty tombstone, hard-deleted only when meta.owner_uid is null (guest: never pushed). With owner_uid set —
 *  including state needs_login — it stays a tombstone until pushed. No undo: the UI confirms. */
export function deleteList(id: ListId): Promise<Result<void>>;
/** Rows with quantity > 0 of live lists (`lists.deleted = 0`), joined in SQL with catalog_parts and
 *  catalog_part_colors only; colour and category names come from getPalette() (WP5) in JS, so they never depend
 *  on a seeded table. imageUrl = coloured image when catalog_part_colors has one, else the generic part image. */
export function getItems(listId: ListId | null): Promise<InventoryRow[]>;
/** RG_08: for each delta, quantity = clamp(quantity + delta, 0, 100000), row created when missing (base_quantity 0).
 *  Deltas on the same key are summed first. Rows with quantity = 0 and base_quantity = 0 are deleted (RG_10).
 *  `inverse` holds the deltas actually applied, negated. */
export function applyDeltas(deltas: readonly ItemDelta[]): Promise<AppliedDeltas>;
export function setQuantity(ref: ItemRef, quantity: number): Promise<AppliedDeltas>;      // EX_16; 0 hides (RG_10)
/** EX_16: −q on the source key, +q on the target key in one transaction (q = whole quantity by default). */
export function moveItem(ref: ItemRef, toListId: ListId, quantity?: number): Promise<AppliedDeltas>;
/** Used by catalog.hydrateParts (D7): moves the quantity of every item of oldPartId onto newPartId (same list and
 *  colour; summed when the target exists, base_quantity of the target unchanged) and deletes the old rows.
 *  Only rows with base_quantity = 0 are moved; a row with base_quantity > 0 is left untouched (cannot happen while
 *  pending parts are never synced — defensive). Emits 'mutation'. */
export function renamePart(oldPartId: PartId, newPartId: PartId): Promise<void>;
/** meta.last_list_id when it is still a live list, else ensureDefaultList().id (EX_07). */
export function getLastListId(): Promise<ListId>;
export function setLastListId(id: ListId): Promise<void>;

// src/domain/inventory/inventory.ts (pure)
export function validateListName(name: string, existing: readonly string[]): Result<string>;   // returns the trimmed name
/** RG_08 / RG_10 on plain data; inventoryRepo runs exactly this inside withWrite (items = the affected rows,
 *  read on tx; base_quantity is carried through unchanged). */
export function mergeDeltas(items: readonly (InventoryItem & { base_quantity: number })[], deltas: readonly ItemDelta[],
  nowIso: string): { items: (InventoryItem & { base_quantity: number })[]; deleted: ItemRef[]; applied: AppliedDeltas };
/** Search (case/diacritics-insensitive on partLabel(name), official part name, part id, colour FR/EN name,
 *  category FR name), colour and category filters, then grouping (category titles = categoryLabel); sections and
 *  rows sorted by title / name. groupBy 'none' → one section with key 'all'. */
export function filterAndGroup(rows: readonly InventoryRow[], filter: InventoryFilter): InventorySection[];
export function inventoryTotals(rows: readonly InventoryRow[]): { refs: number; pieces: number };

// src/domain/inventory/export.ts (pure) — EX_18
export interface ExportRow { listName: string; partId: PartId; partName: string; colorId: ColorId; colorName: string;
  colorHex: string; quantity: number; bricklinkItemId: string; bricklinkColorId: number | null }
export function toExportRows(rows: readonly InventoryRow[]): ExportRow[];
//   bricklinkItemId = part.bricklinkIds[0] ?? partId; colorName = Rebrickable name; missing catalogue data → '' / partId
/** UTF-8 with BOM, CRLF, RFC 4180 quoting. Header:
 *  list,part_id,part_name,color_id,color_name,color_hex,quantity,bricklink_item_id,bricklink_color_id */
export function toCsv(rows: readonly ExportRow[]): string;
/** { "app": "BrickHeap", "version": 1, "exportedAt": iso, "items": ExportRow[] }, 2-space indent. */
export function toJson(rows: readonly ExportRow[], exportedAt: string): string;
/** <INVENTORY><ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>…</ITEMID><COLOR>…</COLOR><MINQTY>…</MINQTY></ITEM>…</INVENTORY>
 *  Rows are merged by (bricklinkItemId, bricklinkColorId) across lists (quantities summed). Rows whose colour has
 *  no BrickLink id (59 of 275 Rebrickable colours [V]) are not written and are returned in `skipped`. XML-escaped. */
export function toBricklinkXml(rows: readonly ExportRow[]): { xml: string; skipped: ExportRow[] };
/** 'brickheap-<slug(list name or "tout")>-<YYYYMMDD>.<csv|json|xml>' — ASCII slug. */
export function exportFileName(format: ExportFormat, listName: string | null, date: Date): string;

// src/services/exportShare.ts
/** Builds the file in Paths.cache (expo-file-system `File`), then expo-sharing `shareAsync(uri, { mimeType, UTI,
 *  dialogTitle })`. mimeType/UTI: text/csv · public.comma-separated-values-text, application/json · public.json,
 *  application/xml · public.xml. Never rejects. err('invalid') when there is nothing to export;
 *  err('unknown') when sharing is unavailable. */
export function shareExport(format: ExportFormat, listId: ListId | null): Promise<Result<{ rows: number; skipped: number }>>;

// src/hooks/useInventory.ts — re-query on 'inventory' | 'lists' | 'catalog'
export function useLists(): AsyncState<ListSummary[]>;
export function useInventory(listId: ListId | null): AsyncState<InventoryRow[]>;
```

Screens:

- **InventoryScreen (C2, C5, EX_15/16)**: horizontal list chips (« Tout » + lists; route param `listId` preselects),
  search field, chips Couleur / Catégorie opening a filter `BottomSheet`, group-by control (Aucun · Catégorie ·
  Couleur · Liste), grid/list toggle (persisted `settings.inventoryView`), footer « {refs} références · {pieces}
  pièces ». Grid = `SectionList`/`FlatList`, `numColumns = max(2, floor(width / 120))`; tile = `PartImage` on
  `colors.tileBg` with **`QuantityBadge` on the image's top-right corner** and, when `!row.coloredImage`, a colour
  cue (`colorCue`, ColorDot bottom-left); name = `partLabel(name)`, `ColorDot` + colour label. Tile a11y label
  « {nom}, {couleur}, quantité {n}, appuyer pour ouvrir ». Tap → fiche; long-press or « ⋯ » → actions sheet:
  `QuantityStepper` (when it reaches 0: close the sheet, then `setQuantity(ref, 0)` + undo snackbar), « Déplacer
  vers… » (`ListPickerSheet` → `moveItem`), « Supprimer » (close the sheet, then `setQuantity(ref, 0)` + undo
  snackbar `UNDO_MS`). On load: `catalog.hydrateParts(distinct partIds)`. Empty state C5 (« Votre inventaire est
  vide » + « Ouvrir le scanner ») and, for guests, the warn card « Mode sans compte : données uniquement sur cet
  appareil. Créer un compte pour les synchroniser. » (→ `routes.signup`). Search / filters with no match →
  `EmptyState` « Aucun résultat » + « Effacer les filtres » (distinct from the empty inventory). Export button →
  `routes.exportSheet(listId)`.
- **ListsScreen (C3, EX_17)**: rows « {name} — {n} réf. », tap → `routes.inventory(id)`; « ＋ » creates (inline
  sheet with validation message); row « ⋯ » → Renommer / Exporter / Supprimer (Alert confirmation « Supprimer la
  liste « X » et ses {n} références ? »). No swipe gestures (D19).
- **ExportSheet (C4, EX_18, EX_23 "export des données")**: format radio (CSV · JSON · BrickLink XML), scope
  (« {liste} ({n} lignes) » or « Tout l'inventaire »; `listId` '' = all), « Partager ». After sharing: the result is
  shown **inline in the sheet** (no snackbar: a `formSheet` hides it) — « {n} lignes exportées » plus, for
  BrickLink XML, « {k} référence(s) sans couleur BrickLink ignorée(s) » — with « Fermer ».

### 4.9 Auth, account, settings (WP7)

```ts
// src/domain/auth/validation.ts (pure)
export function validateEmail(email: string): string | null;            // French error or null
export function validatePassword(password: string): string | null;      // ≥ 8 characters (EX_20)
export function validateCode(code: string): string | null;              // 6 to 8 digits (remote OTP length may still be 8 [S])
/** Tokens from a deep link: fragment (#) first, then query. */
export function parseAuthUrl(url: string): { accessToken: string | null; refreshToken: string | null;
  type: string | null; errorDescription: string | null };
export type AuthErrorKind = 'invalid_credentials' | 'email_not_confirmed' | 'code_invalid' | 'weak_password'
  | 'email_rate_limited' | 'email_not_authorized' | 'other';
/** Maps a supabase-js auth error (error.code / status / message) to a French AppError; `cause` carries the kind. */
export function mapAuthError(e: unknown): AppError & { cause: AuthErrorKind };

// src/services/auth.ts — every function returns err('not_configured') when supabase is null. None rejects.
/** EX_21. data = { pseudo, cgu_accepted_at }. needsCode = no session returned (e-mail confirmation on).
 *  An already-registered e-mail yields the same result (no enumeration). Keeps the credentials in memory for
 *  confirmedViaLink(). */
export function signUp(input: { email: string; password: string; pseudo?: string }): Promise<Result<{ needsCode: boolean }>>;
/** verifyOtp. purpose 'signup' → type 'email' then, if refused, 'signup' (verify); 'login' → 'email';
 *  'recovery' → 'recovery'. On success a session exists (SIGNED_IN → sessionStore). */
export function verifyCode(input: { email: string; code: string; purpose: CodePurpose }): Promise<Result<void>>;
export function resendCode(email: string, purpose: CodePurpose): Promise<Result<void>>;
/** Sign-up fallback when the e-mail only contains a link (default template): signs in with the in-memory credentials. */
export function confirmedViaLink(): Promise<Result<void>>;
export function signInWithPassword(email: string, password: string): Promise<Result<void>>;
/** "Lien magique" in Expo Go = 6-digit login code: signInWithOtp({ shouldCreateUser: false }).
 *  Unknown e-mail is reported as ok (no enumeration). */
export function requestLoginCode(email: string): Promise<Result<void>>;
/** EX_22: ok whatever the account state; only network / rate-limit errors surface. */
export function requestPasswordReset(email: string): Promise<Result<void>>;
export function updatePassword(newPassword: string): Promise<Result<void>>;
export function updateProfile(input: { pseudo: string | null }): Promise<Result<void>>;
/** Bonus deep link (works in builds; best effort in Expo Go): setSession from the URL tokens. */
export function completeAuthFromUrl(url: string): Promise<Result<{ type: string | null }>>;
/** Tries a final sync and returns the number of local changes still unsynced. */
export function prepareSignOut(): Promise<{ pending: number }>;
/** Order matters: sync.wipeLocalUserData() FIRST (aborts and awaits any in-flight sync, clears owner_uid) →
 *  supabase.auth.signOut({ scope: 'local' }) (its SIGNED_OUT then finds owner_uid null → sync 'disabled', not
 *  'needs_login') → leaveApp(). */
export function signOut(): Promise<void>;
/** EX_23: functions.invoke('delete-account') → on success signOut() (local data wiped too: the confirmation
 *  sheet says so and offers « Exporter d'abord »). */
export function deleteAccount(): Promise<Result<void>>;

// src/services/calibrationSessions.ts
export function saveCalibrationSession(session: CalibrationSession): Promise<Result<{ uri: string }>>;   // Paths.document/calibration/<id>.json
export function listCalibrationSessions(): Promise<{ id: string; createdAt: string; uri: string }[]>;
export function deleteCalibrationSession(id: string): Promise<void>;
export function shareCalibrationSession(uri: string): Promise<Result<void>>;                              // expo-sharing, user-initiated
```

All Supabase calls use `redirectTo = Linking.createURL('auth/callback')` (`exp://…/--/auth/callback` in Expo Go,
`brickheap://auth/callback` in builds) for `emailRedirectTo` / `redirectTo`.

Screens (mockups A1–A6):

- **Welcome (A1)**: logo, tagline, « Créer un compte », « Se connecter », « Continuer sans compte »
  (`enterAsGuest()`), legal line. When `!configured`: the two account buttons are disabled with the note
  « Synchronisation non configurée sur cette installation ».
- **Login (A2)**: e-mail, password (show/hide), « Mot de passe oublié ? », « Se connecter », « Recevoir un code de
  connexion » (→ `requestLoginCode` → `routes.verify(email, 'login')`). **No Apple / Google button** (D12).
  `email_not_confirmed` → `routes.verify(email, 'signup')`. Errors (RG_13): inline message + exits (réessayer, mot
  de passe oublié, continuer sans compte).
- **Signup (A3)**: pseudo (optional), e-mail, password, required checkbox « J'accepte les conditions et la
  politique de confidentialité » (links → `routes.about`), field-level errors, note « Un e-mail de confirmation
  vous sera envoyé. Vos données locales sont conservées et synchronisées. »
- **VerifyCode**: code field (`textContentType="oneTimeCode"`, numeric), « Valider », « Renvoyer le code »
  (60 s cooldown), for sign-up « J'ai confirmé via le lien de l'e-mail » (`confirmedViaLink`), « Modifier
  l'e-mail », « Déjà un compte ? Se connecter » (→ `routes.login`; an already-registered e-mail never receives a
  sign-up code) and, when `!entered`, « Continuer sans compte ». `recovery` success → `routes.newPassword`;
  otherwise `router.dismissAll(); router.replace('/')`.
- **Forgot (A4)**: e-mail → `requestPasswordReset` → always the same card « Si un compte existe, un e-mail vient
  d'être envoyé. » + « Saisir le code reçu » (→ verify 'recovery').
- **NewPassword / PasswordScreen**: new password + confirmation → `updatePassword`.
- **AuthCallback**: `Linking.useLinkingURL()` → `completeAuthFromUrl` → recovery → `/new-password`, else `/`;
  on failure an `ErrorState` with « Se connecter ».
- **Account (A5)**: signed in → initial avatar, pseudo, e-mail, `<SyncStatusLine />` (WP8), rows Modifier le
  profil · Changer le mot de passe · Réglages · Exporter mes données (`routes.exportSheet(null)`) · À propos ·
  Mentions légales · GitHub, « Se déconnecter » (`prepareSignOut`; when `pending > 0` an Alert « {n}
  modification(s) non synchronisée(s) seront perdues » before `signOut`). Guest → warn card + « Créer un compte » /
  « Se connecter » + Réglages / Exporter / À propos. Session expired (`useSyncStatus().state === 'needs_login'`) →
  banner « Session expirée — reconnectez-vous pour reprendre la synchronisation. Vos données locales sont
  conservées. » (RG_12) with « Se connecter » and « Conserver ces données sur cet appareil (mode sans compte) »
  (`sync.keepLocalAsGuest()`, after an Alert confirmation). `offline` is never shown as an expired session.
- **Settings (A6)**: Langue (Français, read-only) · Torche au lancement · Retours haptiques · Explorer en direct ·
  Mode Calibration (when on, row « Ouvrir la calibration ») · Confidentialité & données (→ about) · « Supprimer
  mon compte » (signed in only; confirmation sheet requiring the word SUPPRIMER, text « Votre compte et vos
  données synchronisées seront supprimés, ainsi que l'inventaire de cet appareil. » with a link « Exporter
  d'abord » → `routes.exportSheet(null)`; `deleteAccount`). The mockup's
  « Sync Wi-Fi uniquement » row is dropped (§8.2).
- **About**: version, GitHub link, non-affiliation notice, data sources (Rebrickable, Brickognize), **privacy
  notice** (photos of bricks are sent to Brickognize for identification and may be used by that service under its
  terms; BrickHeap stores no photo; personal data = e-mail and pseudo only), CGU summary.
- **Calibration**: §7.1.

### 4.10 Sync (WP8)

```ts
// src/domain/sync/sync.ts (pure)
export interface LocalListRow { id: ListId; name: string; created_at: string; deleted: 0 | 1; dirty: 0 | 1 }
export interface LocalItemRow { list_id: ListId; part_id: PartId; color_id: ColorId; quantity: number; base_quantity: number;
  /** The part is a 'pending' provisional part (D7): never pushed. syncRepo computes it by joining catalog_parts
   *  (source 'brickognize' and resolution 'pending'). */
  held: boolean }
export interface LocalState { lists: LocalListRow[]; items: LocalItemRow[] }
/** Mirrors the server checks of public.sync so a batch is never deterministically rejected. */
export const BATCH_LIMITS = { items: 2000, lists: 200, nameMax: 60, partIdMax: 40, deltaMax: 100000 } as const;
/** lists = dirty rows (≤ BATCH_LIMITS.lists); items = rows with quantity ≠ base_quantity, not held, whose list is
 *  live, as deltas clamped to ±deltaMax (≤ BATCH_LIMITS.items). Rows the server would reject (list name not
 *  1..nameMax after trim, part_id length not 1..partIdMax) are left out and returned in `invalid`. `more` = some
 *  eligible rows did not fit (the service loops). */
export function buildBatch(local: LocalState, batchId: string):
  { batch: SyncBatch; more: boolean; invalid: { lists: ListId[]; items: ItemRef[] } };
export function isEmptyBatch(batch: SyncBatch): boolean;
/** pending = dirty lists + items with quantity ≠ base_quantity (held included); awaitingCatalog = held ones. */
export function pendingCount(local: LocalState): { pending: number; awaitingCatalog: number };
export interface ApplyPlan {
  upsertItems: LocalItemRow[];        // full rows to write (held is not stored)
  deleteItems: ItemRef[];
  upsertLists: LocalListRow[];
  deleteLists: ListId[];              // remove the list and its items locally
  since: string;                      // response.server_time, verbatim
}
/** `local` = state read INSIDE the same withWrite callback that writes the plan (may contain edits made during
 *  the request).
 *  0. A sent or returned item absent from local.items is treated as { quantity 0, base_quantity 0 } (e.g. the
 *     user undid an add while the request was in flight, or removed the item before a pending batch was resent).
 *  1. Acknowledge: for each sent item delta, base_quantity += delta.
 *  2. For each returned item with server quantity S: localDelta = quantity − base_quantity;
 *     base_quantity = S; quantity = max(0, S + localDelta).
 *  3. Items (sent or returned) whose list is a local tombstone or ends in deleteLists are never upserted.
 *  4. Returned lists: deleted → deleteLists; live and absent locally → inserted with dirty = 0; live and present:
 *     if the local row is dirty and either was not in `sent` or was edited after the batch was built (name or
 *     deleted differs from what was sent) → keep local values, dirty = 1; else name/created_at from the server,
 *     dirty = 0.
 *  5. Sent lists not edited meanwhile → dirty = 0; sent tombstones → deleteLists.
 *  6. Items with quantity = 0 and base_quantity = 0 → deleteItems.
 *  7. fullPull = true: local items with quantity = base_quantity > 0 that are absent from the response → deleteItems.
 *  8. dedupeListNames over the resulting live lists; renamed rows go to upsertLists. */
export function applyResponse(local: LocalState, sent: SyncBatch, response: SyncResponse, fullPull: boolean): ApplyPlan;
/** Deterministic, so every device computes the same result: among live lists whose trimmed, case-insensitive
 *  names collide, the one with the smallest (created_at, id) keeps the name; the others become « {name} (2) »,
 *  « (3) »… (truncated to 60 characters) with dirty = 1. Returns only the changed rows. */
export function dedupeListNames(lists: readonly LocalListRow[]): LocalListRow[];
/** true when `since` is null or older than 60 days (server tombstones are purged after 90). */
export function needsFullPull(since: string | null, now: Date): boolean;
/** First sync of a device for an account (RG_11): maps local live lists to remote lists by trimmed,
 *  case-insensitive name, IGNORING remote lists with deleted: true; unmatched local lists stay as new lists. */
export function planGuestMerge(localLists: readonly LocalListRow[], remoteLists: readonly SyncListWire[]):
  { listIdMap: Record<ListId, ListId>; newLists: ListId[] };
/** Rewrites list_id through listIdMap and sums rows that collide on (list, part, colour); base_quantity stays 0. */
export function remapGuestItems(items: readonly LocalItemRow[], listIdMap: Readonly<Record<ListId, ListId>>): LocalItemRow[];
/** ≥ 1 returned item with quantity > 0 in a non-deleted list, or ≥ 1 non-deleted list named other than
 *  `defaultListName`. An account holding only an empty « Mon inventaire » has no data. */
export function accountHasData(probe: SyncResponse, defaultListName: string): boolean;
/** Same definition on the local side (live lists, items with quantity > 0). */
export function localHasData(local: LocalState, defaultListName: string): boolean;
/** Step-4 guard: false when meta.owner_uid changed or a wipe / keepLocalAsGuest bumped the generation since the
 *  request started — the response is then discarded. */
export function isResponseCurrent(captured: { uid: string; generation: number },
  current: { ownerUid: string | null; generation: number }): boolean;

// src/data/syncRepo.ts (WP8) — readLocalState(tx), writePlan(tx, plan), remap/merge/wipe/keep-as-guest writes;
// every function takes the `tx` of a withWrite callback opened by sync.ts.

// src/services/sync.ts
export const syncStore: Store<SyncStatus>;
export function useSyncStatus(): SyncStatus;                            // stable reference from the store
/** Idempotent. Registers: AppState 'active' → syncNow('foreground'); dbEvents 'mutation' → recompute
 *  pending / awaitingCatalog immediately (one cheap query) and syncNow('mutation') after a 2 s debounce;
 *  sessionStore user changes → sign-in procedure / state update (below). Returns the unsubscribe function. */
export function startSync(): () => void;
/** Single-flight, never rejects. ok(void) and no request when guest, not configured, merge_pending,
 *  account_mismatch, or nothing to push and last sync < 30 s ago (unless reason 'manual' / 'login'). */
export function syncNow(reason?: 'foreground' | 'mutation' | 'manual' | 'login'): Promise<Result<void>>;
/** Answer to the guest-merge prompt (state 'merge_pending'):
 *  'merge' → apply the planned name mapping (planGuestMerge + remapGuestItems), set owner_uid, apply the probe
 *  as a full pull; the ordinary push then adds the local quantities (RG_11);
 *  'keep_account' (after a second confirmation) → delete local lists/items, set owner_uid, apply the probe;
 *  'cancel' → supabase.auth.signOut({ scope: 'local' }), local data untouched, back to guest. */
export function resolveGuestMerge(choice: 'merge' | 'keep_account' | 'cancel'): Promise<void>;
/** Answer to state 'account_mismatch' (signed in as B, local data owned by A):
 *  'replace' → wipeLocalUserData, then the first-sync procedure for B;
 *  'keep_as_guest' → keepLocalAsGuest() then supabase.auth.signOut({ scope: 'local' }) (A's data stays here as
 *  guest data; signing in to B again later offers the merge);
 *  'cancel' → supabase.auth.signOut({ scope: 'local' }) (data stays owned by A → needs_login). */
export function resolveAccountMismatch(choice: 'replace' | 'keep_as_guest' | 'cancel'): Promise<void>;
/** RG_12 dead-end exit: detaches local data from the account. Inside one withWrite: owner_uid, since and
 *  pending_batch cleared, base_quantity = 0 on every item, rows with quantity 0 deleted, tombstoned lists
 *  deleted, live lists dirty = 1; bumps the generation; state 'disabled' (guest). */
export function keepLocalAsGuest(): Promise<void>;
/** Aborts the in-flight request (AbortController passed to the rpc builder's `.abortSignal()`), awaits the
 *  single-flight promise, bumps the generation, then inside one withWrite deletes lists, items and the meta keys
 *  owner_uid / since / pending_batch / last_list_id (keeps device_id and the catalogue cache);
 *  notify('inventory', 'lists'). */
export function wipeLocalUserData(): Promise<void>;

// src/screens/sync/GuestMergeHost.tsx — renders the RG_11 prompt (state 'merge_pending') and the other-account
// prompt (state 'account_mismatch'); mounted once in the root layout
export function GuestMergeHost(): ReactElement | null;
// src/screens/sync/SyncStatusLine.tsx — « ✓ synchronisé il y a 2 min » / « Synchronisation… » / « Hors ligne —
// {n} modification(s) en attente » / « {k} pièce(s) en attente d'identification catalogue » (awaitingCatalog) /
// error + « Réessayer » (syncNow('manual')); icon + text
export function SyncStatusLine(): ReactElement | null;
```

Sync algorithm (`syncNow`):

1. Preconditions: `supabase` configured, `sessionStore.user` set, `meta.owner_uid === user.id` (else the sign-in
   procedure below runs first). Capture `{ uid: user.id, generation }` (in-memory counter bumped by
   `wipeLocalUserData` / `keepLocalAsGuest`) and create the request's `AbortController`.
2. If items are held back (`awaitingCatalog > 0`), trigger `catalog.hydrateParts(heldPartIds)` without awaiting
   it (D7: the resolved rows are pushed by a later sync).
3. If `meta.pending_batch` exists, resend it unchanged (same `batchId`: the server ignores a batch it already
   applied). Otherwise `buildBatch(local, randomUUID())` and persist it in `meta.pending_batch` **before** the call;
   `invalid` rows are reported in `SyncStatus.error` (« {n} élément(s) invalide(s) non synchronisé(s) »).
4. `supabase.rpc('sync', { p_device_id, p_batch_id, p_since, p_lists, p_items }).abortSignal(signal)` with
   `p_since = null` when `needsFullPull`, else `meta.since` verbatim. Lists are sent as
   `{ id, name, created_at, deleted }`.
5. In **one `withWrite` callback**: re-read `meta.owner_uid` on `tx`; if `!isResponseCurrent(captured, …)` discard
   the response and stop; else read the local state on `tx`, `applyResponse`, write the plan, set `meta.since` to
   `server_time` verbatim, clear `meta.pending_batch`. Then `notify('inventory', 'lists')` (never `'mutation'`).
6. While `more` was true, loop to step 3 (at most 10 rounds per call).
7. Errors: network, abort, or auth-js `AuthRetryableFetchError` (offline token refresh) → state `offline` (retry on
   next trigger); HTTP 401 / SQLSTATE `28000` → `needs_login`; SQLSTATE `54000`, `22xxx`, `23xxx` (deterministic
   rejection; the server rolled the whole batch back) → discard `pending_batch`, state `error`, the next sync
   rebuilds from `quantity − base_quantity` (cannot double-apply); any other error → `error`, the pending batch is
   resent later unchanged. The UI never blocks on sync.

Sign-in procedure (a session user appears, from SIGNED_IN or the kv snapshot at boot):

| Local situation | Action |
|---|---|
| `owner_uid === user.id` | ordinary `syncNow('login')` (session renewed, RG_12) |
| `owner_uid` null (first sync of this device for an account — every case) | **probe**: `sync` with empty arrays and `p_since = null` (read-only apart from the device row); `planGuestMerge(local live lists, probe.lists)` (deleted remote lists ignored). If `localHasData && accountHasData(probe)` → state `merge_pending` → `GuestMergeHost`: « Fusionner {n} référence(s) locale(s) avec votre compte ? Les quantités seront additionnées. » — « Fusionner » / « Garder uniquement mon compte » (second confirmation) / « Annuler ». Otherwise, without prompt, the same steps as « Fusionner »: inside one `withWrite`, remap lists by name (an empty local « Mon inventaire » collapses into the account's), set `owner_uid`, apply the probe as a full pull; then an ordinary `syncNow` pushes local quantities |
| `owner_uid` is another user | state `account_mismatch` → `GuestMergeHost` Alert « Cet appareil contient les données d'un autre compte. » — « Remplacer par les données de ce compte » (`resolveAccountMismatch('replace')`) / « Conserver ces données sur cet appareil (mode sans compte) » (`'keep_as_guest'`) / « Annuler » (`'cancel'`) |

Session expiry (RG_12): `needs_login` is entered **only** on a SIGNED_OUT event while `owner_uid` is set (auth-js
emits it after a non-retryable refresh error; an explicit sign-out clears `owner_uid` first), or on HTTP 401 /
`28000` from the RPC. An offline start with an expired access token keeps the kv user and shows `offline`; when
the network returns, auth-js refreshes (TOKEN_REFRESHED) and sync resumes. Local data stays usable; syncing resumes
after re-login as the same user; the banner also offers `keepLocalAsGuest`.

Conflict rules recorded for the specs (§8.4): quantities = sum of deltas floored at 0; a list delete is final, so
items added offline on device B to a list deleted on device A are dropped with the list; list names: last push
wins, then `dedupeListNames` restores uniqueness identically on every device.

## 5. Work packages

Import directions allowed between packages (stubs make every import compile from day one):

| Package | May import from |
|---|---|
| WP1 UI kit | WP0, `COMMON_OPAQUE_COLOR_IDS` (WP2, for the colour picker sections) |
| WP2 vision core | `types.ts` only |
| WP3 pile logic + scan services | WP0, WP2, `catalog.resolveCandidates` / `getPalette` + `partInfo.partLabel` / `provisionalPart` (WP5), `inventoryRepo.applyDeltas` / `setLastListId` (WP6) |
| WP4 scanner UI | WP0, WP1, WP2 (`geometry`, `config`, `live`), WP3 (store, review, grouping, `i18n/fr/scan`), `partInfo.parseDimensions` / `partLabel` + `usePalette` (WP5), `useLists` + `createList` + `getLastListId` (WP6) |
| WP5 catalogue | WP0, WP1, `inventoryRepo.renamePart` / `applyDeltas` / `createList` + `useLists` (WP6) |
| WP6 inventory | WP0, WP1, `catalog.hydrateParts` / `getPalette` + `usePalette` + `partInfo.partLabel` / `categoryLabel` (WP5) |
| WP7 auth/account | WP0, WP1, `sync` service + `SyncStatusLine` (WP8), `scanStore.lastResult` + `calibration.ts` (WP3) |
| WP8 sync/backend | WP0, WP1, `catalog.hydrateParts` (WP5), `DEFAULT_LIST_NAME` (WP6) |

WP0 stubs that run during boot or from the root layout must be harmless: `SnackbarHost`, `GuestMergeHost`
(render `null`), `startSync` (returns a no-op unsubscribe).

### 5.0 WP0 — Foundation (runs first, alone)

**Owns (permanently):** `package.json`, `package-lock.json`, `app.json`, `tsconfig.json`, `eslint.config.js`,
`.env.example`, `.gitignore`, `src/app/**` (all route files and layouts of §3), `src/domain/types.ts`,
`src/domain/result.ts`, `src/domain/keys.ts`, `src/domain/utf8.ts`, `src/domain/__tests__/smoke.test.ts`,
`src/domain/__tests__/foundation.test.ts`, `src/theme.ts`, `src/navigation/routes.ts`, `src/i18n/format.ts`,
`src/i18n/fr/common.ts`, `src/i18n/fr/colors.ts`, `src/state/createStore.ts`, `src/state/session.ts`,
`src/state/settings.ts`, `src/services/env.ts`, `src/services/supabase.ts`, `src/services/kv.ts`,
`src/data/db.ts`, `src/data/dbEvents.ts`, `src/data/meta.ts`, `src/hooks/useAsync.ts`, `src/hooks/useBoot.ts`,
`src/types/upng-js.d.ts`, `src/screens/NotFoundScreen.tsx`, `src/screens/BootErrorScreen.tsx`.

**Deletes:** `src/screens/ScannerScreen.tsx`, `src/screens/PlaceholderScreen.tsx` (after seeding stubs that do not
need it), `src/components/Screen.tsx` is kept and handed to WP1.

**Tasks:**

1. Research material is already in the repo: `docs/research/segment.prototype.js` (handed to WP2) and
   `supabase/tests/00_stub.sql`, `99_test.sql` (handed to WP8). Nothing to copy.
2. Install dependencies (§2). Update config files (§4.2).
3. Write the foundation modules of §4.1–4.2 in full, the root layout, the tabs layout, the `(auth)` layout and all
   route re-exports of §3.
4. Seed **stubs** for every file owned by WP1–WP8 that another package imports: exact exported names and
   signatures from §4.3–§4.10; functions `throw notImplemented('<name>')`; hooks return
   `{ data: undefined, loading: true, error: null, reload() {} }`; components and screens render a minimal
   placeholder (`<Screen title="…" />`); `src/i18n/fr/<area>.ts` files export an empty typed object. Stub
   `SnackbarHost`, `GuestMergeHost`, `startSync` must be harmless no-ops so the app boots. Return types use
   `ReactElement`, never the global `JSX`.
5. Verify (WP0 alone in the tree, so whole-tree commands are meaningful here): `npx tsc --noEmit`, `npx jest`,
   `npx expo lint`, `npx expo-doctor`, and `npx expo export --platform android --output-dir
   <scratchpad>/export-check` (Metro resolves every import).

**Specs:** EX_19 (tab bar, first-launch routing), RG_12 (persistent session, foreground auto-refresh), RT_02
(tokens: key in SecureStore, encrypted session), acceptance "no API key in the bundle outside `EXPO_PUBLIC_*`".

**Tests (`foundation.test.ts`):** `itemKey`/`parseItemKey` round trip; `toAppError` mapping (network TypeError →
offline, 401, 429, 500); `plural` (0, 1, 2), `fmtBadge` (99 → '99', 100 → '99+'), `fmtPercent`, `tpl`;
`createStore` (set merges, functional set, subscribe/unsubscribe); `colorLabel` (known id, unknown id, null);
`utf8Encode`/`utf8Decode` round trip on ASCII, « Élodie — pièce ½ », an emoji (surrogate pair) and a 4 KB JSON
string, and byte-exact output for « é » (`C3 A9`); `toSessionUser` (pseudo present / absent / non-string);
`withWrite` ordering cannot be unit-tested without SQLite and is covered by the WP0 device check below.

**Acceptance:** all commands of task 5 pass; the app boots in Expo Go to the welcome screen, « Continuer sans
compte » is not wired yet but tabs render when `entered` is forced; no `.env` value appears in any file.
Device check by the orchestrator/user on one iPhone and one Android phone in Expo Go (temporary dev button, removed
before hand-back, or a scratch script): the encrypted session storage round-trips (`setItem` → `getItem` of a JSON
string with « é ») and two concurrent `withWrite` callbacks run one after the other.

### 5.1 WP1 — UI kit, docs and QA assets

**Owns:** `src/components/**` (`Icon`, `Screen`, `Button`, `TextField`, `StateViews`, `Banner`, `Snackbar`,
`ColorDot`, `ConfidenceBadge`, `QuantityStepper`, `QuantityBadge`, `PartImage`, `Chip`, `ListRow`, `SwitchRow`,
`SegmentedControl`, `BottomSheet`, `ColorPickerSheet`, `ListPickerSheet`), `src/services/feedback.ts`,
`src/i18n/fr/ui.ts`, `docs/FUNCTIONAL_SPECS.md`, `docs/UX_UI_MOCKUPS.md`, `docs/mockups-preview.html`,
`docs/ARCHITECTURE_CLOUD.md`, `docs/DEVICE_SETUP.md`, `docs/DEVICE_TEST_SCRIPT.md` (new, from §7.4), `README.md`,
`CONTRIBUTING.md`, `.github/workflows/ci.yml`.

**Contracts:** §4.3; doc-update task §8.4; CI adds `npx expo lint` after the TypeScript step.

**Specs:** RG_04 (badge: icon + text + colour), EX_06 (stepper, colour picker), EX_07 (list picker), RG_09/EX_16
(undo snackbar), §6 accessibility criteria, mockup palette and typography.

**Tests:** none (no pure logic). **Acceptance:** every component renders with only its required props; all
pressables ≥ 48 dp with role + label; `ConfidenceBadge` distinguishable in greyscale; `Snackbar` action fires once
and the bar disappears after `durationMs`; sheets close on backdrop press and Android back; text scales with the
system font size without clipping at 130 %; `QuantityStepper` accepts a typed value (120 in one entry) and clamps
it; `PartImage` draws the colour cue when given; `ColorPickerSheet` shows the reference crop and measured swatch
when given; docs updated per §8.4.

### 5.2 WP2 — Vision core (pure)

**Owns:** `src/domain/vision/**` (`config.ts`, `segment.ts`, `lab.ts`, `color.ts`, `geometry.ts`, `tracker.ts`,
`live.ts`, `detections.ts`, `testing/synth.ts`, `__tests__/*`), `docs/research/segment.prototype.js`.

**Contracts:** §4.4, Appendix A. Typed arrays only; no allocation inside per-pixel loops beyond the prototype's;
no `Buffer`, no Node API.

**Specs:** RG_02 (tracker), RG_03 (NMS at IoU > 0.6, `partial` flag), EX_01/EX_05 (segmentation), D6 local colour.

**Tests:**

- `segment.test.ts` (synthetic buffers, 320×240): five separated coloured rectangles on white, grey and
  gradient backgrounds → five boxes, each IoU ≥ 0.5 with its truth, quality `plain`; two touching rectangles of
  different colours → two boxes; a rectangle cut by the border → `partial`; checkerboard → quality `patterned`;
  empty background → no box; a soft shadow beside a piece neither adds a box nor drops the IoU below 0.5; a blob
  3.5× the median area → `suspectMerged`; dominant colour of a red rectangle with a glare stripe within ΔE00 10 of
  the fill; wrong buffer length → `RangeError`; same input twice → deep-equal output; `segmentPileAsync` with a
  counting `yieldFn` deep-equals `segmentPile` and yields at least 5 times.
- `lab.test.ts`: white → L ≈ 100, black → L ≈ 0; `labToRgb(rgbToLab(c))` within ±1 for 20 colours; `ciede2000`
  against published Sharma test pairs (at least five pairs, tolerance 1e-3); symmetry.
- `color.test.ts`: `nearestColors` skips transparent, −1 and 9999; honours `allowed` and `k`; the exact hex of
  Red (`C91A09`) ranks Red first with ΔE 0; `COMMON_OPAQUE_COLOR_IDS` has 40 distinct ids.
- `geometry.test.ts`: `iou` (identical 1, disjoint 0, half-overlap 1/3); `nms` (pair at IoU 0.7 → higher score
  kept; pair at IoU 0.5 → both kept); `coverTransform` / `containTransform` on known sizes; `boxToView` then
  `viewToImagePoint` round trip; `hitTest` picks the smallest box; `boxToPixelRect` clamps and never returns a
  zero size; `fitWithin`; `pickPictureSize` (smallest 4:3 ≥ 1920 chosen over a smaller-but-16:9 and over a
  larger 4:3; no 4:3 → smallest ≥ 1920; empty list → undefined); `orientationMatches` (portrait/portrait true,
  landscape photo on portrait view false, square tolerance).
- `live.test.ts`: `adaptLive` — slow 'ok' stretches the interval up to `maxIntervalMs` then drops `segMaxSide` to
  192; fast 'ok' shrinks back to the default; 'skipped' resets failures; three 'failed' in a row → disabled; a slow
  cycle never increments failures.
- `tracker.test.ts`: same box → same id and hits 2; shifted box at IoU 0.6 → same id; IoU 0.4 → new id; missed
  once → kept, missed twice → removed; two tracks and two boxes are matched one-to-one by best IoU.
- `detections.test.ts`: NMS applied on tight boxes; cap at `VISION.maxBoxes` with `truncated`; `manualDetection`
  is pixel-square and clamped.

**Acceptance:** tests green; `segmentPile` on a 320×240 buffer runs in < 150 ms under Jest (JIT) and, as a Hermes
proxy, in < 600 ms with `node --jitless` on the dev machine (prototype: 442 ms) — record both numbers in the
hand-back note; no import outside `src/domain`.

### 5.3 WP3 — Pile logic and scan services

**Owns:** `src/domain/pile/**` (`thresholds.ts`, `brickognizeParse.ts`, `colorFusion.ts`, `grouping.ts`,
`review.ts`, `calibration.ts`, `__tests__/*`), `src/services/imaging.ts`, `src/services/brickognize.ts`,
`src/services/scanPipeline.ts`, `src/state/scanStore.ts`, `src/i18n/fr/scan.ts`.

**Contracts:** §4.5.

**Specs:** RG_01, RG_04, RG_05, RG_06, RG_07 (quantity overrides), RG_09 (session memory + undo), RG_10 (quantity
0 removes the line), EX_04, EX_05 (pipeline), EX_09 (`unavailable` + retry), EX_10/EX_11 (metrics, session JSON).

**Tests:**

- `thresholds.test.ts`: `confidenceLevel` at 0.49 / 0.5 / 0.79 / 0.8; `calibrateScore` anchors, monotonic over
  0..1 in steps of 0.01, clamped; `evaluatePiece`: ambiguity cap, low box score cap, `partConfirmed` → 1,
  pending/empty/unavailable → 0 and `unknown`.
- `brickognizeParse.test.ts`: the real response below → one candidate `3001` (pseudo-item dropped), colours
  `[5, 17, 11]`, boxScore 0.979, status `identified`; the empty response → `empty`; `null`, a string and an object
  without `items` → `unavailable`; the real response with the `colors` key removed → `identified`, colors `[]`.
- `colorFusion.test.ts`: the four rules, transparent colour reliable without local agreement, `lab: null` path,
  unmapped BrickLink colour dropped, alternatives distinct and ≤ 5.
- `grouping.test.ts` (RG_05/06/03): 3 × (3001, red) + 2 × (3020, grey) → two `ok` groups with counts 3 and 2;
  an unreliable colour forms a separate `color_to_confirm` group; partial and unknown pieces are single groups;
  a piece with a provisional part (source 'brickognize') is grouped like a resolved one (not 'u:'); group
  confidence is the minimum; `cropUri` = first member's crop; order is deterministic for shuffled input;
  `lineCandidates` unions by bricklinkId with the max score.
- `review.test.ts`: quantity clamp and 0 → removed; `setLineColor` merges into the existing key and drops
  overrides; `confirmAllColors` skips lines whose colorId is null; `confirmPartial`; `chooseCandidate` on a
  three-member line applies to all members (candidate appended where absent, line re-keyed and merged);
  `toDeltas` only for addable lines; `reviewSummary.canAdd` false while a colour is to confirm; `toVerify` counts
  unconfirmed 'review' pieces of addable lines; `alreadyAdded` from the session map.
- `calibration.test.ts`: `parseExpected` (all separators, default quantity, duplicate keys summed, error lines);
  `computeMetrics` for a perfect match, one false positive, one false negative, a colour-only error (precision
  drops, `partPrecision` stays 1), an expected line without colour, empty inputs.

Fixtures for `brickognizeParse.test.ts` (real responses captured by the research [V]):

```json
{"listing_id":"res-12911859dfdc46bc",
 "bounding_box":{"left":9.09,"upper":39.9,"right":182.9,"lower":151.4,"image_width":192.0,"image_height":192.0,"score":0.979},
 "items":[
  {"id":"3001","name":"Brick 2 x 4","img_url":"https://storage.googleapis.com/brickognize-static/thumbnails/v5.0/part/3001/5.webp",
   "external_sites":[{"name":"bricklink","url":"https://www.bricklink.com/v2/catalog/catalogitem.page?P=3001"}],
   "category":"Brick","type":"part","score":0.652},
  {"id":"3001special","name":"Brick 2 x 4 special (special bricks, test bricks and/or prototypes)","category":"Brick","type":"part","score":0.544}],
 "colors":[{"id":"5","name":"Red","score":0.848},{"id":"17","name":"Trans-Red","score":0.221},{"id":"11","name":"Black","score":0.200}]}
```
```json
{"listing_id":"res-x","bounding_box":{"left":0,"upper":0,"right":0,"lower":0,"image_width":0,"image_height":0,"score":0},"items":[],"colors":[]}
```

Brickognize facts to respect [V]: `bounding_box` is expressed in the server-resized image → normalise with
`image_width` / `image_height`; JPEG and PNG are accepted, other types return 415; a 429 carries
`retry-after: 1` and `x-retry-in: 54.075562ms`. Multipart upload: `fetch` with `FormData` and
`{ uri, name: 'crop.jpg', type: 'image/jpeg' }` (supports `AbortSignal`); if that fails on a device, use
`new File(uri).upload(url, { uploadType: UploadType.MULTIPART, fieldName: 'query_image', mimeType: 'image/jpeg' })`
(resolves on non-2xx too: check `status`) — both stay inside `brickognize.ts`.

**Acceptance:** tests green; with the network off, `capture` ends in `frozen` with grey `unavailable` boxes and
the notice, never an exception; `ingestLiveSnapshot` on an unchanged scene makes zero Brickognize calls after the
first identification, and returns 'skipped' for a landscape photo with a portrait view; `freeze(id)` on a track seen
once identifies it (no piece stays 'pending' with nothing in flight; `retryUnavailable` re-sends such pieces);
`resume()` during analysis drops every later `onPiece` of the old `scanId`; a capture whose photo long side is
≤ 1920 is not re-encoded; with the proxy unreachable every identified piece still gets a provisional part and an
`ok`/`color_to_confirm` group; in `explore` mode no row is written to `lists`/`items`.

### 5.4 WP4 — Scanner and review UI

**Owns:** `src/screens/scanner/**`, `src/i18n/fr/scanner.ts`.

**Contracts:** §4.6.

**Specs:** RG_01 (drawer appears from 2 boxes), RG_04 (colours + icons + top-3 chooser), RG_07 (« ≈ », `+ / −`),
RG_09 (warning + 10 s undo), EX_01, EX_02, EX_03, EX_05, EX_06, EX_07, EX_08, EX_09, acceptance "camera active
in < 3 s", mockups B1–B4.

**Tests:** none (logic lives in WP2/WP3). **Acceptance:** device script sections A–D (§7.4); the mode switch never
remounts `CameraView`; leaving the tab unmounts it; no capture is started before `onCameraReady` or while another
is in flight; on Android the picture size is queried once per install and the second `onCameraReady` does not
re-query; Android back collapses the drawer / resumes a frozen scan; a live Inventorier box tap does nothing and its
drawer shows the count only; « Reprendre » is enabled while analysing; ReviewScreen without a review redirects to
the scanner; every box and drawer row has an accessibility label « {nom} {couleur}, {confiance} %, {statut},
appuyer pour ouvrir ».

### 5.5 WP5 — Catalogue (Edge Function, client, fiche pièce)

**Owns:** `supabase/functions/catalog-proxy/**` (`index.ts`, `deno.json`, `smoke.sh`),
`supabase/functions/_shared/**` (`rebrickable.ts`, `mapping.ts`), `src/services/catalog.ts`,
`src/data/catalogRepo.ts`, `src/data/seed/palette.json`, `scripts/gen-palette.mjs`,
`src/domain/catalog/**` (`partInfo.ts`, `__tests__/partInfo.test.ts`, `__tests__/catalogMapping.test.ts`,
`__tests__/palette.test.ts`), `src/hooks/useCatalog.ts`, `src/screens/part/**`, `src/i18n/fr/part.ts`,
`src/i18n/fr/catalog.ts`.

**Contracts:** §4.7, §6.2.

**Specs:** EX_12, EX_13, EX_14, RT_01, D7 mapping, D6 palette.

**Tests:**

- `partInfo.test.ts`: `parseDimensions` on "Brick 2 x 4", "Panel 4 x 4 x 6 Quarter Cylinder", "Vehicle Base,
  Trailer 8 x 30 x 3 1/3", "Slope 30° 1 x 1 x 2/3" and a Technic pin name (null); `designId`; `pickABrickUrl`
  with and without element ids (encoding); `filterSets` and `setYears`; `partLabel` ('Brick 2 x 4' → 'Brique
  2 × 4', 'Plate Round 1 x 1', 'Slope 45 2 x 1', an unmapped name unchanged); `categoryLabel` (known id, unknown id
  with fallback, null); `provisionalPart` fields and resolution.
- `palette.test.ts`: `buildPalette` on `src/data/seed/palette.json` — `byBricklinkId.get(77).colorId === 148` and
  `.get(72).colorId === 313` (lowest Rebrickable id wins), ids −1 / 9999 absent, every category id of the seed has
  a `CATEGORY_NAMES_FR` entry.
- `catalogMapping.test.ts` (imports `supabase/functions/_shared/mapping.ts`, which must have **no import**):
  `pickPrimary` — exact `part_num` match wins (`3001` among `3001`, `3556`); single result (`3062` → `3062b`);
  several results without exact match → `print_of === null` with the latest `year_to` (`44302` → among `44302a`,
  `44302b`, `54657`); empty → null; `validateIds` (≤ 50, charset `^[A-Za-z0-9._-]{1,30}$`, de-duplication);
  `toPartRow` field mapping.

**Acceptance:** tests green; `palette.json` holds ≥ 270 colours and 76 categories, only the keys `generatedAt`,
`colors`, `categories`, and the value check of §5.10 step 4 prints 0 for it; with the proxy unreachable
`resolveCandidates` returns provisional parts (`resolution: 'pending'`) within the HTTP timeout and the fiche shows
cached identity + an error state for sets; `hydrateParts` asks the proxy at most once per 7 days for an id answered
`not_found`; `smoke.sh` documents the post-deploy curl checks (takes the URL and publishable key from the
environment, prints HTTP status and JSON shape only).

### 5.6 WP6 — Inventory, lists, export

**Owns:** `src/data/inventoryRepo.ts`, `src/domain/inventory/**` (`inventory.ts`, `export.ts`, `__tests__/*`),
`src/services/exportShare.ts`, `src/hooks/useInventory.ts`, `src/screens/inventory/**`, `src/screens/lists/**`,
`src/screens/export/**`, `src/i18n/fr/inventory.ts`.

**Contracts:** §4.8.

**Specs:** EX_15, EX_16, EX_17, EX_18, RG_08 (local merge), RG_10, RG_11 (guest mode fully local), EX_07 (last
used list), EX_23 (data export entry), mockups C2–C5.

**Tests:**

- `inventory.test.ts`: `mergeDeltas` — new key created, existing key incremented (RG_08), several deltas on one
  key summed, negative delta floors at 0 and removes the row (RG_10), cap at 100000, `inverse` restores the
  original state exactly (including a floored delta), `base_quantity` carried through, a row at quantity 0 with
  base_quantity > 0 kept (tombstone) and reported only when base is 0 in `deleted`; `validateListName` (empty, 61
  chars, duplicate with different case/accents); `filterAndGroup` (query « brique » matches a row named 'Brick 2 x 4'
  through `partLabel`, « Brique » and « brick » too; colour filter; category filter; each `groupBy`, category
  titles in French); `inventoryTotals`.
- `export.test.ts`: CSV — BOM, CRLF, header, quoting of `"`, `,` and newlines; JSON — parseable, shape, count;
  BrickLink XML — exact structure for two rows, `&` and `<` escaped, same BrickLink key from two lists merged,
  colour without BrickLink id in `skipped`; `exportFileName`.

**Acceptance:** tests green; device script section F; a guest can create lists, edit, move, delete with undo and
export with the network off; the quantity badge sits on the image's top-right corner and shows `99+` above 99;
every write goes through `withWrite` and runs `mergeDeltas` (no merge SQL); a brand-new guest opening Listes sees
« Mon inventaire »; the undo snackbar is visible after « Supprimer » / stepper to 0 (sheet closed first); the export
result is shown inside the sheet.

### 5.7 WP7 — Auth, account, settings, calibration screen

**Owns:** `src/services/auth.ts`, `src/services/calibrationSessions.ts`, `src/domain/auth/**` (`validation.ts`,
`__tests__/validation.test.ts`), `src/screens/auth/**`, `src/screens/account/**`, `src/screens/settings/**`,
`src/i18n/fr/auth.ts`, `src/i18n/fr/account.ts`, `src/i18n/fr/calibration.ts`.

**Contracts:** §4.9, §7.1.

**Specs:** EX_19 (welcome), EX_20 (e-mail/password + code; Apple/Google deferred, §8.2), EX_21, EX_22, EX_23,
RG_12 (re-login UI), RG_13, EX_10, EX_11 (screen + JSON export), mockups A1–A6.

**Tests (`validation.test.ts`):** e-mail (valid, missing TLD, spaces), password (7 vs 8 characters), code (5, 6, 8
digits, letters); `parseAuthUrl` (fragment, query, `error_description`, no tokens); `mapAuthError` for
`invalid_credentials`, `email_not_confirmed`, `otp_expired`, `over_email_send_rate_limit`, `weak_password`,
"Email address not authorized", a network `TypeError` (→ `offline`) and an unknown error.

**Acceptance:** tests green; device script section G; forgot-password shows the identical message for an existing
and a non-existing e-mail; every auth error shows a message and at least one exit; with Supabase not configured
all auth screens explain it and « Continuer sans compte » works; no password or token is written to logs, route
params or kv (the kv `session.user` snapshot holds id, e-mail and pseudo only); `signOut` wipes before calling
`auth.signOut` so the sync state ends in `disabled`, never `needs_login`; VerifyCode offers « Se connecter » and,
for a guest-less first launch, « Continuer sans compte ».

### 5.8 WP8 — Backend SQL/config and sync

**Owns:** `supabase/migrations/20261115000000_sync_catalog.sql`, `supabase/config.toml`, `supabase/templates/**`
(`confirmation.html`, `magic_link.html`, `recovery.html`), `supabase/functions/delete-account/**`,
`supabase/tests/**` (`00_stub.sql`, `99_test.sql`, `run.sh`), `src/domain/sync/**` (`sync.ts`,
`scenarios.ts`, `__tests__/sync.test.ts`), `src/data/syncRepo.ts`, `src/services/sync.ts`, `src/screens/sync/**`
(`GuestMergeHost.tsx`, `SyncStatusLine.tsx`), `src/i18n/fr/sync.ts`.

**Contracts:** §4.10, §6.1 (incl. the scenario table §6.1.1), §6.3, §6.4. Files only: **no** `db push`,
`functions deploy`, `config push`. `npx supabase config diff` and `npx supabase migration list --remote`
(read-only) may be used to check.

**Specs:** RG_08 (server-side sum), RG_10 (tombstones), RG_11 (merge with confirmation, quantities added), RG_12
(`needs_login`), EX_23 (sync status, `delete-account`), RT_01 (cache tables and grants).

**Tests (`sync.test.ts`):** `buildBatch` (dirty lists, deltas only for changed items, items of deleted lists
excluded, **held items excluded but counted in `awaitingCatalog`**, chunking at `BATCH_LIMITS.items` with `more`,
a 61-character name and a 41-character part id land in `invalid`, delta clamped); `applyResponse` —
acknowledgement, edit made during the request preserved (`quantity = S + localDelta`), server quantity 0 with no
local delta → row deleted, returned deleted list removes its items, list renamed locally during the request stays
dirty, a returned list dirty locally but not in `sent` keeps its local values, full pull drops stale rows but keeps
unsynced ones; **undo while in flight** (sent +3, local row gone, response S = 3 → row q 0 / base 3, next batch
delta −3); **resend of a pending batch after local removal**; **returned item for a locally tombstoned list** (not
upserted); `dedupeListNames` (two « Mon inventaire » → the older keeps it, the other « Mon inventaire (2) » dirty,
same result whatever the input order); `needsFullPull` (null, 59 days, 61 days); `planGuestMerge` (« Mon
inventaire » vs « mon inventaire  » match, unmatched list, **a deleted remote list of the same name is ignored**);
`remapGuestItems` collisions summed; `accountHasData` / `localHasData` (only an empty default list → false);
`isResponseCurrent` (uid change, generation bump); the first-sync rows of the sign-in table with an existing remote
« Mon inventaire » (local empty default collapses into it; no prompt); every scenario of §6.1.1 run against an
in-memory fake of `public.sync` (`src/domain/sync/scenarios.ts` exports the table **and** the fake, so the SQL test
and Jest share the same inputs and expected outputs).

**`supabase/tests/run.sh`** (bash, no Docker): `initdb` into `mktemp -d` (short socket path under `/tmp` is
allowed here because it is a throwaway cluster outside the repo), `pg_ctl start -o "-k <dir> -p 54329"`, then
`psql -v ON_ERROR_STOP=1` on `00_stub.sql` → `supabase/migrations/20261114000000_init.sql` →
`20261115000000_sync_catalog.sql` → `99_test.sql`; stops and removes the cluster on exit (`trap`). Exit code ≠ 0
on any failure. **`99_test.sql` asserts** every scenario of §6.1.1 with `do $$ … if <unexpected> then raise
exception '<scenario id>: …'; end if; … $$` (no print-only checks).

**Acceptance:** tests green; `bash supabase/tests/run.sh` exits 0 on the local PostgreSQL (installed at
`/usr/local/bin`); the migration file equals §6.1; `config.toml` differs from the remote only on the keys of §6.4
(`config diff`); the app with Supabase not configured never calls the network for sync; every SQLite write of
`syncRepo` happens inside the `withWrite` callback opened by `sync.ts` (read + apply + write in one callback);
device script section H after the user actions of §8.3.

### 5.9 Coverage table

| ID | Package(s) | Where |
|---|---|---|
| RG_01 | WP3, WP4 | `pieces.length ≥ 2` → drawer header « X pièces détectées » |
| RG_02 | WP2, WP3 | `tracker.updateTracks`, `ingestLiveSnapshot` |
| RG_03 | WP2, WP3, WP4 | `nms` (IoU > 0.6), `partial` flag, `partial` groups excluded until confirmed. Deviation: "visible à < 40 %" is approximated by "cut by the frame"; occlusion by another piece is not measurable (§8.4) |
| RG_04 | WP3, WP1, WP4 | `thresholds.ts` (calibrated, D5), `ConfidenceBadge` (orange badge opens the chooser in drawer and review), overlay colours, `CandidateChooser` (`lineCandidates`, with the piece's crop), « dont {n} à vérifier » |
| RG_05 | WP3 | `groupPieces` (provisional parts grouped immediately) |
| RG_06 | WP3, WP4 | `fuseColor`, `color_to_confirm` groups, add blocked until confirmed (« Confirmer {couleur} » / « Tout confirmer » / picker with crop + measured swatch) |
| RG_07 | WP4, WP3 | « ≈ » header and banner, `setLineQuantity` |
| RG_08 | WP6, WP8, WP0 | `applyDeltas` / `mergeDeltas` inside `withWrite`; `public.sync` adds deltas (asserted by `supabase/tests/run.sh`); provisional parts never synced, so reconciliation never double-counts |
| RG_09 | WP3, WP4, WP1 | `sessionAdded`, warning banner, `UNDO_MS` snackbar (sheets closed first) |
| RG_10 | WP6, WP3, WP8 | quantity 0 hides/removes; server tombstones |
| RG_11 | WP6, WP8, WP0 | local tables for guests; first-sync probe + name mapping (deleted lists ignored); `GuestMergeHost` + delta push; `entered` flag |
| RG_12 | WP0, WP8, WP7 | encrypted persisted session + auto-refresh; boot from the kv user snapshot (offline ≠ expired); `needs_login` only on SIGNED_OUT / 401; re-login banner + « Conserver ces données (mode sans compte) » |
| RG_13 | WP7 | `mapAuthError`, exits on every auth screen |
| EX_01 | WP4, WP3, WP2 | native preview + live snapshot loop (D9; box refresh ≈ 0.4 Hz, wording updated §8.4) |
| EX_02 | WP4, WP5 | tap box → `PartScreen`; nothing stored |
| EX_03 | WP4 | `PileDrawer` |
| EX_04 | WP3 | explore mode writes only `catalog_*` |
| EX_05 | WP4, WP3 | shutter → `capture` (≤ 1920 px work image) |
| EX_06 | WP4, WP3, WP1 | `ReviewScreen`, `review.ts`, stepper / colour picker |
| EX_07 | WP4, WP6 | « Ajouter … à {liste} », `getLastListId` |
| EX_08 | WP4 | torch, focus lock (long-press), permission pre-explanation, settings link |
| EX_09 | WP3, WP4 | `unavailable` status, grey boxes, « Réessayer »; Hugging Face removed from the wording (§8.4) |
| EX_10 | WP7, WP3 | settings toggle, `CalibrationScreen`, `parseExpected` |
| EX_11 | WP3, WP7 | `computeMetrics`, `CalibrationSession` JSON saved locally / shared on request |
| EX_12 | WP5 | `PartScreen` identity block, `parseDimensions`, `designId`, element ids |
| EX_13 | WP5 | `pickABrickUrl` |
| EX_14 | WP5 | sets section, filters over loaded pages with « {loaded} sur {total} » + auto-load once, on-demand quantity (D15) |
| RT_01 | WP5, WP8 | `catalog-proxy`, cache tables, loading/error/empty states |
| EX_15 | WP6, WP5 | grid with quantity badge, coloured image (`part_colors`) or colour cue, French labels (`partLabel`, `categoryLabel`), list view, grouping, filters, « Aucun résultat » state |
| EX_16 | WP6, WP1 | stepper (typed value), `moveItem`, delete + undo |
| EX_17 | WP6 | `ListsScreen`, `createList` / `renameList` / `deleteList` |
| EX_18 | WP6 | `export.ts`, `shareExport`, `ExportSheet` |
| EX_19 | WP0, WP7 | tabs, guards, `WelcomeScreen` |
| EX_20 | WP7, WP0 | e-mail/password, login code; Apple/Google deferred (§8.2) |
| EX_21 | WP7 | `SignupScreen`, `VerifyCodeScreen` |
| EX_22 | WP7 | `ForgotScreen` identical message |
| EX_23 | WP7, WP8, WP6 | account screens, `SyncStatusLine`, `delete-account`, data export |
| RT_02 | WP0 | `supabase.ts` storage; only e-mail/pseudo stored |
| §6 criteria | WP0/WP4 (< 3 s), device script (≥ 80 % on 20 pieces), WP0 + CI (no secret), all + WP1 (accessibility) | |

### 5.10 Gate (after all packages)

1. Whole-tree checks (first time they are meaningful): `npx tsc --noEmit`, `npx jest --ci`, `npx expo lint`,
   `npx expo-doctor`, `npx expo install --check`, `bash supabase/tests/run.sh`.
2. `npx expo export --platform ios` and `--platform android` into `<scratchpad>/export-ios` and
   `<scratchpad>/export-android` (bundling succeeds).
3. `grep -R "notImplemented(" src` returns only `src/domain/result.ts`; `grep -R "JSX\.Element" src` is empty.
4. Secrets: no forbidden dependency (§2) in `package.json`; `git status` shows no `.env`; `grep -R "REBRICKABLE" src`
   is empty; `app.json` has no `extra` entry (no non-public value may reach the bundle through app config).
   **Value-based check, printing counts only — never the values:**
   ```bash
   set -a; . ./.env; set +a
   for v in REBRICKABLE_API_KEY TEST_USER_PASSWORD; do
     val=$(printenv "$v"); [ -n "$val" ] || continue
     printf '%s: ' "$v"; grep -rlF -- "$val" <scratchpad>/export-ios <scratchpad>/export-android src supabase scripts docs app.json 2>/dev/null | wc -l
   done
   ```
   Every count must be 0. No French literal in `src/screens` / `src/components` outside `src/i18n` (spot check).
5. Collect contract gaps reported by the packages and fix them in one integration pass.
6. Run §7.4 on one iPhone and one Android phone in Expo Go; record the timings of I2 and apply the go/no-go rule
   of §8.1 R2.

## 6. Backend

Findings that shape this section [S]: the tables of migration 1 have **no grant** for any API role (even
`service_role` gets `42501`), so nothing works through the Data API until migration 2; `public.sync` and the
function design were exercised on a throwaway local PostgreSQL 14 with stubbed `auth` (not on the real project,
Postgres 17); neither Docker nor Deno is installed, so the Edge Functions cannot be run locally.

### 6.1 Migration 2 — `supabase/migrations/20261115000000_sync_catalog.sql` (WP8 writes this file verbatim)

Compared with the tested research version, additive changes were made for this plan: four extra columns on
`parts_cache` (`lego_ids`, `print_of`, `year_from`, `year_to`), the tables `bricklink_map_cache`,
`part_color_lists_cache` and `set_part_qty_cache`, and no GIN index on `parts_cache.bricklink_ids`. A reviewer ran
migration 1 + the research migration + `99_test.sql` on the local PostgreSQL 14 (`/usr/local/bin/postgres`): it
applies, but `99_test.sql` only printed results. **WP8 must make `99_test.sql` assert every scenario of §6.1.1 and
run it through `supabase/tests/run.sh` (required, PostgreSQL is installed); the gate runs it again.**

```sql
-- BrickHeap migration 2: explicit Data API grants, catalog caches, offline-first sync.

-- 1. Catalog caches: only the Edge Function (service_role) touches them -------
drop policy "read parts" on public.parts_cache;
drop policy "read colors" on public.colors_cache;

alter table public.parts_cache
  drop column category,
  drop column dims,
  add column part_cat_id int,
  add column bricklink_ids text[] not null default '{}',
  add column lego_ids text[] not null default '{}',
  add column print_of text,
  add column year_from int,
  add column year_to int,
  add column found boolean not null default true;          -- false = negative cache

alter table public.colors_cache
  add column is_trans boolean not null default false,
  add column bricklink_id int,
  add column fetched_at timestamptz not null default now();

create table public.part_categories_cache (id int primary key, name text not null);

create table public.bricklink_map_cache (                   -- Brickognize/BrickLink id -> Rebrickable part_num(s)
  bricklink_id text primary key,
  part_ids text[] not null default '{}',                    -- [primary, ...alternates]; empty = no match
  fetched_at timestamptz not null default now());

create table public.part_colors_cache (                     -- EX_12 element ids + coloured image
  part_id text not null, color_id int not null,
  element_ids text[] not null default '{}', image_url text, num_sets int,
  found boolean not null default true,
  fetched_at timestamptz not null default now(),
  primary key (part_id, color_id));

create table public.part_color_lists_cache (                -- marks "all colours of this part fetched" (op part_colors)
  part_id text primary key,
  fetched_at timestamptz not null default now());

create table public.part_color_sets_cache (                 -- EX_14, one row per Rebrickable page
  part_id text not null, color_id int not null, page int not null,
  total int not null, sets jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (part_id, color_id, page));

create table public.set_part_qty_cache (                    -- EX_14 quantity, filled on demand
  set_num text not null, part_id text not null, color_id int not null,
  quantity int not null,                                    -- 0 = the set does not contain it
  fetched_at timestamptz not null default now(),
  primary key (set_num, part_id, color_id));

alter table public.part_categories_cache enable row level security;
alter table public.bricklink_map_cache enable row level security;
alter table public.part_colors_cache enable row level security;
alter table public.part_color_lists_cache enable row level security;
alter table public.part_color_sets_cache enable row level security;
alter table public.set_part_qty_cache enable row level security;

grant select, insert, update, delete on
  public.parts_cache, public.colors_cache, public.part_categories_cache, public.bricklink_map_cache,
  public.part_colors_cache, public.part_color_lists_cache, public.part_color_sets_cache, public.set_part_qty_cache
  to service_role;

-- 2. User data: natural key, quantity 0 = tombstone, writes only through sync() --
alter table public.lists
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz,
  add constraint lists_name_len check (char_length(name) between 1 and 60);

alter table public.inventory_items
  drop column id,                                           -- drops the surrogate PK
  drop constraint inventory_items_list_id_part_id_color_id_key,
  add primary key (list_id, part_id, color_id),
  drop constraint inventory_items_quantity_check,
  add constraint inventory_items_quantity_check check (quantity between 0 and 100000),
  add constraint inventory_items_part_len check (char_length(part_id) between 1 and 40);

create index lists_user_updated_idx on public.lists (user_id, updated_at);
create index inventory_items_user_updated_idx on public.inventory_items (user_id, updated_at);

create table public.sync_devices (                          -- idempotency: last batch applied per device
  user_id uuid not null references auth.users on delete cascade,
  device_id uuid not null,
  last_batch_id uuid not null,
  last_sync_at timestamptz not null default now(),
  primary key (user_id, device_id));
alter table public.sync_devices enable row level security;  -- no policy, no grant: sync() only

drop policy "own lists" on public.lists;
drop policy "own items" on public.inventory_items;
create policy lists_select_own on public.lists for select to authenticated
  using (user_id = (select auth.uid()));
create policy items_select_own on public.inventory_items for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.lists, public.inventory_items to authenticated;

-- 3. One round trip: push local changes (list upserts + quantity deltas), pull what changed.
create function public.sync(
  p_device_id uuid, p_batch_id uuid, p_since timestamptz default null,
  p_lists jsonb default '[]', p_items jsonb default '[]')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_array_length(p_lists) > 200 or jsonb_array_length(p_items) > 5000 then
    raise exception 'batch too large' using errcode = '54000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));  -- one sync at a time per user
  v_now := clock_timestamp();

  if not exists (select 1 from public.sync_devices
                 where user_id = v_uid and device_id = p_device_id and last_batch_id = p_batch_id) then
    -- lists: last push wins on the name, a delete is final
    insert into public.lists as t (id, user_id, name, created_at, updated_at, deleted_at)
    select l.id, v_uid, l.name, coalesce(l.created_at, v_now), v_now,
           case when coalesce(l.deleted, false) then v_now end
    from jsonb_to_recordset(p_lists) as l(id uuid, name text, created_at timestamptz, deleted boolean)
    on conflict (id) do update
      set name = excluded.name, updated_at = v_now,
          deleted_at = coalesce(t.deleted_at, excluded.deleted_at)
      where t.user_id = v_uid;

    -- deleting a list zeroes its items so other devices drop them
    update public.inventory_items i set quantity = 0, updated_at = v_now
    from public.lists l
    where l.id = i.list_id and l.user_id = v_uid and l.deleted_at = v_now and i.quantity > 0;

    -- items: RG_08 = add the delta; never below 0 (0 = tombstone, RG_10)
    with d as (
      select x.list_id, x.part_id, x.color_id, sum(x.delta)::int as delta
      from jsonb_to_recordset(p_items) as x(list_id uuid, part_id text, color_id int, delta int)
      join public.lists l on l.id = x.list_id and l.user_id = v_uid and l.deleted_at is null
      group by 1, 2, 3
      having sum(x.delta) <> 0
    ), upd as (
      update public.inventory_items i
      set quantity = least(greatest(i.quantity + d.delta, 0), 100000), updated_at = v_now
      from d
      where i.list_id = d.list_id and i.part_id = d.part_id and i.color_id = d.color_id
    )
    insert into public.inventory_items (user_id, list_id, part_id, color_id, quantity, updated_at)
    select v_uid, d.list_id, d.part_id, d.color_id, least(d.delta, 100000), v_now
    from d
    where d.delta > 0 and not exists (
      select 1 from public.inventory_items e
      where e.list_id = d.list_id and e.part_id = d.part_id and e.color_id = d.color_id);

    insert into public.sync_devices as s (user_id, device_id, last_batch_id, last_sync_at)
    values (v_uid, p_device_id, p_batch_id, v_now)
    on conflict (user_id, device_id) do update
      set last_batch_id = excluded.last_batch_id, last_sync_at = v_now;

    delete from public.inventory_items                       -- purge old tombstones
    where user_id = v_uid and quantity = 0 and updated_at < v_now - interval '90 days';
  end if;

  return jsonb_build_object(
    'server_time', v_now,
    'lists', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'created_at', created_at, 'deleted', deleted_at is not null)), '[]'::jsonb)
              from public.lists
              where user_id = v_uid and (p_since is null or updated_at > p_since)),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'list_id', list_id, 'part_id', part_id, 'color_id', color_id, 'quantity', quantity)), '[]'::jsonb)
              from public.inventory_items
              where user_id = v_uid and (p_since is null and quantity > 0 or updated_at > p_since)));
end;
$$;

revoke all on function public.sync(uuid, uuid, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.sync(uuid, uuid, timestamptz, jsonb, jsonb) to authenticated;
```

`sync` RPC contract (client → `supabase.rpc('sync', …)`, authenticated role only):

```json
// request
{ "p_device_id": "8d0f…uuid", "p_batch_id": "c1a2…uuid", "p_since": "2026-11-14T21:03:11.120534+00:00",
  "p_lists": [{ "id": "9999…uuid", "name": "Vrac Salon", "created_at": "2026-11-14T20:00:00Z", "deleted": false }],
  "p_items": [{ "list_id": "9999…uuid", "part_id": "3001", "color_id": 4, "delta": 3 }] }
// response
{ "server_time": "2026-11-14T21:05:42.531208+00:00",
  "lists": [{ "id": "9999…uuid", "name": "Vrac Salon", "created_at": "2026-11-14T20:00:00Z", "deleted": false }],
  "items": [{ "list_id": "9999…uuid", "part_id": "3001", "color_id": 4, "quantity": 5 }] }
```

Semantics: quantity = sum of deltas, floored at 0, capped at 100000; `quantity: 0` in a response is a tombstone;
a full pull (`p_since: null`) returns only items with quantity > 0 but still returns deleted lists
(`deleted: true`, ignored by the client); a list delete is final and later deltas on it are ignored; limits 200
lists / 5000 item deltas per batch (`54000`); unauthenticated → `28000`; client clocks are never used.
`server_time` is returned as Postgres timestamptz text (microseconds, offset): the client stores and resends it
verbatim.

#### 6.1.1 Sync scenarios (shared by `99_test.sql` and `src/domain/sync/scenarios.ts`)

Each scenario starts from an empty account U (and a second user V where stated). "push" = one `sync` call with the
given device, batch id and deltas; quantities are checked on `inventory_items` (SQL) and on the fake (Jest).

| Id | Steps | Expected |
|---|---|---|
| S1 create | U/A creates list L, +3 (3001, 4) | q = 3; response has L and the item |
| S2 replay | S1, then the same batch id again | q = 3 (not 6); response still returned |
| S3 concurrent | S1; A +2 (batch a2); B −7 (batch b1) | q = 0 (floored, not −2), row kept as tombstone |
| S4 sum | U/A +3 and U/B +2 on a new key, separate batches | q = 5 |
| S5 cap | +99 999 then +10 | q = 100 000 |
| S6 delete list | S1; A sends L deleted | L.deleted_at set; item q = 0; full pull returns L with deleted true and no item |
| S7 delta on deleted list | S6; B +1 on L | ignored: q = 0, no error |
| S8 foreign list | U creates L; V sends +1 on L and a rename of L | U's item and name unchanged; V gets an empty success |
| S9 full pull | S3 (q 0) + another key q 2; full pull | only the q 2 item returned |
| S10 incremental pull | after S1, pull with p_since = S1.server_time; B +1 | only rows updated after that time returned |
| S11 limits | 201 lists or 5001 deltas | SQLSTATE 54000, nothing applied |
| S12 invalid row | a 61-character list name | rejected (23514), whole batch rolled back, device row not updated (the same batch id can be resent after fixing) |
| S13 purge | a tombstone with updated_at 91 days ago, then any push | tombstone deleted |
| S14 anon | `sync` as anon | permission denied |
| S15 cascade | delete auth user U | U's lists, items, sync_devices gone |

### 6.2 Edge Function `catalog-proxy` (WP5)

`POST {SUPABASE_URL}/functions/v1/catalog-proxy`, headers `apikey: <publishable key>`,
`Content-Type: application/json`. `verify_jwt = false`; wrapper `withSupabase({ auth: 'publishable' }, …)` from
`@supabase/server` (guests and signed-in users alike; `supabase.functions.invoke` sends the key). Database access
through `ctx.supabaseAdmin` only. CORS handled by the wrapper.

Common rules: ids match `^[A-Za-z0-9._-]{1,30}$`; set numbers `^[A-Za-z0-9-]{1,20}$`; upstream calls are
sequential with ≥ 1100 ms between two calls of the same request; `Authorization: key <REBRICKABLE_API_KEY>` header
(never `?key=`); upstream 404 = "no result"; any other upstream failure → **stale-if-error** (answer from cache
whatever its age, `"stale": true`). TTL: parts and BrickLink map 90 days (negative entries 7 days), detail and
sets pages 30 days, set quantities 180 days, palette 30 days.

| Status | Body | When |
|---|---|---|
| 200 | per operation, always with `"stale": boolean` | success, possibly from stale cache |
| 400 | `{"error":"bad_request","field":"<name>"}` | validation |
| 401 | (wrapper) | missing/invalid publishable key (a legacy anon key is rejected) |
| 405 | `{"error":"method_not_allowed"}` | not POST |
| 502 | `{"error":"upstream"}` | upstream failed and nothing is cached for the request |

**`parts`** — one call for a whole pile.

```json
// request: id_type "bricklink" (Brickognize ids) or "rebrickable" (inventory part_nums); 1..50 distinct ids
{ "op": "parts", "id_type": "bricklink", "ids": ["3001", "3062", "3001special", "99999"] }
// response
{ "parts": {
    "3001": { "status": "found", "part": {
      "part_id": "3001", "name": "Brick 2 x 4", "part_cat_id": 11,
      "image_url": "https://cdn.rebrickable.com/media/parts/elements/300121.jpg",
      "bricklink_ids": ["3001"], "lego_ids": ["15589", "3001", "54534", "72841"],
      "print_of": null, "year_from": 1979, "year_to": 2026 } },
    "3062": { "status": "found", "part": { "part_id": "3062b", "name": "…", "part_cat_id": 0, "image_url": "…",
      "bricklink_ids": ["…"], "lego_ids": ["…"], "print_of": null, "year_from": 0, "year_to": 0 } },
    "3001special": { "status": "not_found" },
    "99999": { "status": "pending" } },
  "stale": false }
```

(The `3062` entry is abbreviated: real values are returned.) Wire field names are snake_case; `catalog.ts` maps
them to `CatalogPart` (`source: 'rebrickable'`).

Algorithm, `id_type: "bricklink"`:

1. Read `bricklink_map_cache` for the ids; fresh entries are resolved from `parts_cache` (first element of `part_ids`), fresh
   empty entries are `not_found`.
2. Remaining ids `M` → **one** call `GET /parts/?part_nums=<M>&inc_part_details=1&page_size=100`. A result `p` is
   accepted for id when `p.part_num === id` and (`external_ids.BrickLink` is missing/empty or contains id).
3. Still unresolved ids: at most **5 per request**, one call each
   `GET /parts/?bricklink_id=<id>&inc_part_details=1&page_size=20`; choose with `pickPrimary(id, results)`:
   `part_num === id`, else the result with `print_of === null` and the latest `year_to`; the others are alternates.
   No result → the step-2 part with `part_num === id` if any, else the id goes to step 3b. Ids beyond the cap →
   `pending` (the client asks again up to 3 more times, so ≤ 20 fallback ids resolve per scan).
   3b. Ids of step 3 with no result whose last character is a digit (mould letter stripped by Brickognize, e.g.
   `2412` → Rebrickable `2412b`; a read-only check on 2026-11-14 found `parts/?bricklink_id=2412` empty) → **one**
   batched call `GET /parts/?part_nums=<id>a,<id>b,<id>c,…&inc_part_details=1&page_size=100`; `pickPrimary(id,
   hits)` among the hits whose `external_ids.BrickLink` is missing or contains id; no hit → negative entry.
4. Upsert `parts_cache` (rows with `found = true`) and `bricklink_map_cache`.

Upstream cost of one request: 1 + ≤ 5 + ≤ 1 calls, ≈ 1.1 s apart → ≤ ≈ 8 s server time; the client is never
blocked by it (provisional parts are already displayed, D7).

`id_type: "rebrickable"`: fresh `parts_cache` rows answer (`found = false` → `not_found`, 7-day TTL); the rest in
one `part_nums` call; ids absent from the result are stored with `found = false`.

**`part_colors`** — every colour of a few parts, for inventory tile images (EX_15), one upstream call per part.

```json
{ "op": "part_colors", "part_ids": ["3001", "3020"] }
{ "parts": { "3001": [{ "color_id": 1, "image_url": "https://cdn.rebrickable.com/media/parts/elements/300123.jpg",
                        "element_ids": ["300123", "300173"], "num_sets": 675 }, …],
             "3020": [ … ] },
  "stale": false }
```

1..5 distinct part ids. A part whose `part_color_lists_cache` row is fresh (30 days) answers from
`part_colors_cache`; otherwise `GET /parts/{id}/colors/?page_size=1000` (404 → `[]`), upsert one
`part_colors_cache` row per colour (`found = true`) and the `part_color_lists_cache` row. These rows also serve the
`detail` operation (its `part_color` step is skipped when a fresh row exists).

**`detail`** — fiche pièce (EX_12 + EX_14), at most two upstream calls.

```json
{ "op": "detail", "part_id": "3001", "color_id": 4, "page": 1 }
{ "part_color": { "part_id": "3001", "color_id": 4, "found": true, "element_ids": ["300121"],
                  "image_url": "https://cdn.rebrickable.com/media/parts/elements/300121.jpg", "num_sets": 1016 },
  "sets": { "total": 1133, "page": 1, "page_size": 100, "sets": [
    { "set_num": "10018-1", "name": "Darth Maul", "year": 2001, "num_parts": 1868,
      "image_url": "https://cdn.rebrickable.com/media/sets/10018-1/120261.jpg" } ] },
  "stale": false }
```

`part_color` from `GET /parts/{part_id}/colors/{color_id}/` (404 → `found: false`, `sets: null`); sets from
`GET /parts/{part_id}/colors/{color_id}/sets/?page={page}&page_size=100&ordering=-year` (`page` 1..50), cached one
row per page. `image_url` may be null.

**`set_qty`** — quantity of the part+colour in one set (D15), one upstream call.

```json
{ "op": "set_qty", "set_num": "10018-1", "part_id": "3001", "color_id": 4 }
{ "quantity": 16, "stale": false }
```

`GET /sets/{set_num}/parts/?page_size=1000` (the `part_num`/`color_id` filters are ignored upstream [V]: filter in
the function), sum of `quantity` over rows with matching `part.part_num` and `color.id` and `is_spare === false`;
follow `next` for at most 3 pages; only the requested key is cached; `0` cached → `"quantity": null`.

**`palette`** — colours and categories, at most two upstream calls.

```json
{ "op": "palette" }
{ "colors": [{ "color_id": 4, "name": "Red", "hex": "C91A09", "is_trans": false, "bricklink_id": 5 }],
  "categories": [{ "id": 1, "name": "Baseplates" }], "stale": false }
```

From `GET /colors/?page_size=1000` (skip ids −1 and 9999; `bricklink_id = external_ids.BrickLink.ext_ids[0] ??
null`) and `GET /part_categories/?page_size=200`; refreshed when any `colors_cache.fetched_at` is older than the TTL.

Reference skeleton (**not executed** — check the wrapper API against `https://github.com/supabase/server` and the
template generated by `npx supabase functions new <name> --auth apikey` in a scratch directory before coding):

```jsonc
// supabase/functions/catalog-proxy/deno.json
{ "imports": { "@supabase/functions-js": "jsr:@supabase/functions-js@^2", "@supabase/server": "npm:@supabase/server@^1" } }
```
```ts
// supabase/functions/_shared/rebrickable.ts
const RB = "https://rebrickable.com/api/v3/lego";
let last = 0;
/** Sequential, spaced GET. Returns null on 404, throws on any other non-2xx. */
export async function rb(path: string): Promise<any | null> {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(RB + path, { headers: { Authorization: `key ${Deno.env.get("REBRICKABLE_API_KEY")}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`rebrickable ${r.status}`);
  return await r.json();
}

// supabase/functions/_shared/mapping.ts — pure, NO import (unit-tested from Jest)
export interface RbPart { part_num: string; name: string; part_cat_id: number | null; part_img_url: string | null;
  year_from?: number | null; year_to?: number | null; print_of?: string | null; external_ids?: Record<string, string[]> }
export interface PartRow { part_id: string; name: string; part_cat_id: number | null; image_url: string | null;
  bricklink_ids: string[]; lego_ids: string[]; print_of: string | null; year_from: number | null; year_to: number | null;
  found: boolean; fetched_at: string }
export function validateIds(ids: unknown, max: number): string[] | null;      // distinct, 1..max, charset; else null
export function acceptsBricklinkId(p: RbPart, id: string): boolean;
export function pickPrimary(id: string, results: RbPart[]): { primary: RbPart; alternates: string[] } | null;
export function toPartRow(p: RbPart, nowIso: string): PartRow;
export function isFresh(fetchedAt: string, ttlDays: number, now: number): boolean;

// supabase/functions/catalog-proxy/index.ts
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
const json = (body: unknown, status = 200) => Response.json(body, { status });
export default {
  fetch: withSupabase({ auth: "publishable" }, async (req, ctx) => {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await req.json().catch(() => null);
    const db = ctx.supabaseAdmin;
    switch (body?.op) {
      case "parts": return parts(db, body);
      case "detail": return detail(db, body);
      case "part_colors": return partColors(db, body);
      case "set_qty": return setQty(db, body);
      case "palette": return palette(db);
      default: return json({ error: "bad_request", field: "op" }, 400);
    }
  }),
};
```

The function never logs request bodies or the key. Mitigations for the public key [S]: strict validation, 50-id
cap, negative caching, stale-if-error; no built-in rate limiter is assumed.

### 6.3 Edge Function `delete-account` (WP8)

`POST {SUPABASE_URL}/functions/v1/delete-account`, `Authorization: Bearer <user access token>` (added by
`supabase.functions.invoke`), empty body. `verify_jwt = true`, wrapper `auth: 'user'`.

| Status | Body |
|---|---|
| 200 | `{"ok":true}` — `auth.admin.deleteUser(userId)`; `lists`, `inventory_items`, `sync_devices` cascade |
| 401 | (platform/wrapper) invalid or missing JWT |
| 405 | `{"error":"method_not_allowed"}` |
| 500 | `{"error":"delete_failed"}` |

```ts
// supabase/functions/delete-account/index.ts (not executed) — deno.json identical to catalog-proxy
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(ctx.userClaims!.id);
    return error ? Response.json({ error: "delete_failed" }, { status: 500 }) : Response.json({ ok: true });
  }),
};
```

An access token already issued stays valid until it expires (≤ 1 h); the client signs out locally right after.

### 6.4 `supabase/config.toml` and e-mail templates (WP8, files only)

`supabase config push` pushes **every** declared property; today's file would disable e-mail confirmation and
change unrelated settings remotely [S]. WP8 therefore edits only the keys below and checks with
`npx supabase config diff` that nothing else differs from the remote project; the push itself is a user action.

```toml
[auth]
site_url = "brickheap://auth/callback"
additional_redirect_urls = ["brickheap://**", "exp://**"]   # exp://** is for Expo Go development only
enable_anonymous_sign_ins = false
minimum_password_length = 8                                  # EX_20

[auth.email]
enable_confirmations = true                                  # EX_21
otp_length = 6
max_frequency = "1m0s"

[auth.email.template.confirmation]
subject = "Confirmez votre compte BrickHeap"
content_path = "./supabase/templates/confirmation.html"
[auth.email.template.magic_link]
subject = "Votre code de connexion BrickHeap"
content_path = "./supabase/templates/magic_link.html"
[auth.email.template.recovery]
subject = "Réinitialisez votre mot de passe BrickHeap"
content_path = "./supabase/templates/recovery.html"

[functions.catalog-proxy]
verify_jwt = false
[functions.delete-account]
verify_jwt = true

# Required for recipients outside the project team (built-in SMTP: team addresses only, 2 e-mails/hour):
# [auth.email.smtp]
# enabled = true
# host = "…"  port = 587  user = "…"  pass = "env(SMTP_PASS)"  admin_email = "…"  sender_name = "BrickHeap"
```

Templates carry both the code and the link so the flow works with or without deep links, e.g.
`supabase/templates/magic_link.html`:

```html
<h2>BrickHeap</h2>
<p>Votre code : <strong>{{ .Token }}</strong> (valable 1 heure)</p>
<p>Ou ouvrez ce lien sur votre téléphone : <a href="{{ .ConfirmationURL }}">Se connecter</a></p>
```

`confirmation.html` (« Confirmez votre adresse e-mail ») and `recovery.html` (« Réinitialisez votre mot de
passe ») have the same shape. Whether template **content** is pushed by `config push` on the Free plan is
unverified; otherwise the user pastes them in the dashboard (§8.3).

## 7. Calibration, accessibility, states, device tests

### 7.1 Calibration mode (EX_10 / EX_11)

- **Activation**: « Mode Calibration » switch in Réglages (off by default, discreet). When on, the scanner top bar
  shows a flask button and Réglages shows « Ouvrir la calibration ». Nothing else changes in the normal flow.
- **Data source**: `scanStore.lastResult`, i.e. the last completed Inventorier capture (pieces after the user's
  corrections are *not* used: calibration measures the raw pipeline). No scan yet → empty state « Faites d'abord
  un scan en mode Inventorier » + « Ouvrir le scanner ».
- **Screen** (`settings/CalibrationScreen.tsx`):
  1. « Dernier scan » card: time, number of boxes, background quality, timings (préparation, segmentation,
     identification, catalogue, total, number of Brickognize calls).
  2. « Liste attendue » multi-line field, placeholder `3001/4 x3`, help text « Une ligne par référence :
     PartID/ColorID xQuantité. La couleur est facultative. »; parse errors listed with their line number.
  3. « Comparer » → side-by-side table (EX_10): Référence · Attendu · Détecté · Écart, one row per key of the
     union, with an icon (✓ equal, ↑ too many, ↓ missing) and text; summary: précision, rappel, précision/rappel
     « pièce seule » (colour ignored), écart de comptage (EX_11).
  4. « Enregistrer la session » → `buildCalibrationSession` → `saveCalibrationSession` (JSON in the app's
     document directory). Saved sessions are listed (date, précision, rappel) with « Partager » (system share
     sheet, explicit user action) and « Supprimer ».
- **Privacy**: the session JSON contains boxes, scores, ids and timings — no image, no personal data. Photos are
  never stored by BrickHeap; identifying a calibration scan sends crops to Brickognize exactly like a normal scan
  (the spec sentence « images non envoyées sur le réseau » is reworded to say that the *export* contains no
  image, §8.4).
- **Use**: the acceptance criterion « pile de 20 pièces simples bien séparées : ≥ 80 % identifiées correctement »
  = `recall ≥ 0.8` on that scene. The per-detection `rawScore` / `confidence` / `level` in saved sessions are the
  data used to adjust `SCORE_CALIBRATION` and `SEGMENT_DEFAULTS`; every adjustment comes with a Jest regression
  case.

### 7.2 Accessibility requirements (all packages)

1. Every pressable has `accessibilityRole`, a French `accessibilityLabel` and, where relevant,
   `accessibilityState` (`selected`, `disabled`, `checked`, `busy`) and `accessibilityHint`.
2. Touch targets ≥ 48 × 48 dp (`hitSlop` allowed to reach it); steppers and the shutter included.
3. Information is never carried by colour alone: confidence = icon (✓ / ? / –) + text + colour; active tab =
   colour + bold; errors = icon + text; a colour dot is always accompanied by the colour name.
4. Text contrast ≥ 4.5:1: light text on `bg`/`surface`; dark text on `tileBg` and `primary`.
5. Dynamic type: no fixed-height text containers; layouts hold at 130 % font scale; only overlay label chips may
   set `maxFontSizeMultiplier={1.4}`.
6. Screen readers: boxes and drawer rows read « {nom} {couleur}, {n} %, {statut}, appuyer pour ouvrir »;
   inventory tiles read name, colour and quantity; `AccessibilityInfo.announceForAccessibility` for « {n} pièces
   détectées », « {n} pièces ajoutées à {liste} », undo, and errors; form errors use
   `accessibilityLiveRegion="polite"`; sheets set `accessibilityViewIsModal`.
7. Every gesture has a non-gesture alternative: drawer header tap (drag), « ⋯ » button (long-press), buttons for
   remove/confirm.
8. Motion: animations ≤ 250 ms and skipped when `AccessibilityInfo.isReduceMotionEnabled()`.
9. Feedback: haptic on add / undo / error through `feedback` (setting-controlled) plus a visual cue, because iOS
   suppresses haptics while the camera is active.

### 7.3 Error, empty and offline states (the user is never blocked)

| Situation | What the user sees | Way out |
|---|---|---|
| Local database cannot open | `BootErrorScreen` « Impossible de démarrer » | « Réessayer » |
| Supabase not configured | Welcome: account buttons disabled + note; Compte: info banner | « Continuer sans compte »; everything local works; parts are provisional |
| Camera permission not asked / refused | Pre-explanation sheet / explanatory screen (B4) | « Autoriser la caméra » / « Ouvrir les réglages »; other tabs usable |
| Camera mount error | `ErrorState` on the scanner | « Réessayer » |
| No piece in view | Banner « Pointez la caméra vers vos briques » | — |
| Patterned background | Banner « Étalez les pièces sur une surface unie, sans qu'elles se touchent. » + single-piece fallback | manual box by tapping the still |
| More than 60 boxes | Banner « Trop de pièces : étalez-en moins à la fois » (60 largest kept) | rescan a smaller pile |
| Piece too small | Grey box « trop petite — rapprochez-vous » | rescan closer |
| Brickognize down / offline / 429 (EX_09) | Boxes stay, grey, cloud-off icon; banner « Identification indisponible » | « Réessayer » (`retryUnavailable`); « Reprendre » |
| Brickognize found nothing | Grey « Inconnue » box, no candidate | remove the box, or rescan closer / from another angle |
| Live loop slow | Boxes refresh less often (interval up to 6 s), no message | — |
| Live loop failing (3 thrown captures) | Banner « Mode direct indisponible sur cet appareil » | « Analyser » button (manual Explorer) |
| Phone held in landscape, then flat (Android) | Live boxes not drawn for that snapshot; hint « Tenez le téléphone en portrait » after 3 | hold in portrait; « Analyser » / shutter still work |
| Long analysis (many boxes, slow network) | Boxes shown as soon as segmented, filling progressively | « Reprendre » always enabled (aborts the analysis); Android back |
| Review opened without a scan (restored route) / all lines removed | Redirect to the scanner / « Aucune pièce à ajouter » | « Reprendre le scan » |
| Catalogue mapping slow (cold cache) | Provisional names and images, swapped when resolved | — |
| Signed-in items whose part is still unresolved | `SyncStatusLine` « {k} pièce(s) en attente d'identification catalogue » | resolved automatically when the proxy answers |
| Catalogue proxy unreachable / not deployed / paused project | Scan and add work with provisional parts; fiche: banner « Pièce non référencée… » or `ErrorState` on sets | « Réessayer »; automatic reconciliation later |
| Part without colour-specific data | « Cette pièce n'est pas référencée dans cette couleur » | change colour |
| Colour to confirm (RG_06) | Review line « Couleur à confirmer », add button disabled with the reason | choose a colour or remove the line |
| Empty inventory / empty list | C5 empty state (+ guest card) | « Ouvrir le scanner » |
| Search / filters / sets filter with no match | « Aucun résultat » (inventory) · « {loaded} sur {total} sets chargés » + auto-load once (sets) | « Effacer les filtres » · « Charger plus » |
| Lists tab for a brand-new guest | « Mon inventaire » (created by `getLists`) | — |
| Inventory rows not yet hydrated / no coloured image | Tile with placeholder or generic image, the part id or name, and a colour cue (dot) on the image | hydrates when online (`part_colors`, ≤ 25 parts per session) |
| Export with nothing to export / sharing unavailable | Inline message in the sheet | close |
| Auth error (RG_13) | Inline French message | retry · mot de passe oublié · continuer sans compte |
| E-mail not delivered (SMTP limits) | « Trop d'e-mails envoyés… » or « Cette adresse ne peut pas recevoir d'e-mail pour l'instant » | resend after 60 s; « J'ai confirmé via le lien »; continue as guest |
| Session expired (RG_12) | Compte: banner « Session expirée… », sync state `needs_login` (only after auth-js signed the user out, never when merely offline) | « Se connecter »; « Conserver ces données sur cet appareil (mode sans compte) »; local data intact |
| Signed in as another account than the local data's owner | Prompt « Cet appareil contient les données d'un autre compte. » | Remplacer · Conserver (mode sans compte) · Annuler |
| Sign-up code never arrives (address already registered) | VerifyCode screen | « Déjà un compte ? Se connecter » · « Continuer sans compte » |
| Sync offline / error | `SyncStatusLine` « Hors ligne — {n} modification(s) en attente » / error text | automatic retry; « Réessayer » |
| Guest merge needed (RG_11) | Modal prompt | Fusionner · Garder uniquement mon compte · Annuler |
| Account deletion fails | Error message in the confirmation sheet | retry; account untouched |
| Unknown route | `NotFoundScreen` | « Revenir au scanner » |

### 7.4 Device test script (WP1 turns this into `docs/DEVICE_TEST_SCRIPT.md`)

Run on one iPhone and one Android phone, in **Expo Go**, same Wi-Fi (`npx expo start`, `--tunnel` if needed).
Material: about 30 real bricks including **20 simple, clean pieces** (bricks, plates, tiles, slopes in common
colours: red, blue, yellow, white, black, light bluish gray), one transparent piece, one printed piece, two
pieces of the same colour; a plain light table, a plain dark surface, a patterned surface (tablecloth); daylight
and indoor light. Before starting, write the expected list of the 20-piece pile (`PartID/ColorID xQty`, ids looked
up on rebrickable.com). Record every number asked for below, per device.

**A. Start-up and permission** (no backend needed)
1. Cold start → welcome screen; « Continuer sans compte » → Scanner tab. Kill and relaunch → Scanner directly.
2. Permission sheet text mentions Brickognize; « Plus tard » leaves a usable app; « Autoriser » shows the camera.
   Refuse at system level → « Ouvrir les réglages » opens the system settings.
3. Time from tapping the app in Expo Go to a live preview on relaunch: **< 3 s**. Notch / Dynamic Island and the
   Android navigation bar do not cover controls.

**B. Explorer (live)**
1. Five spread pieces on the light table: boxes appear within ≈ 5 s without touching anything; record the box
   refresh period and whether the preview freezes or a shutter sound is heard at each snapshot.
2. **Alignment**: boxes sit on the pieces in the live preview (error < 5 % of the screen width). On Android check
   in particular the top and bottom of the preview. If misaligned, note the device and photo/preview sizes.
   **Android rotation case**: tilt the phone to landscape for 2 s, then lay it flat above the pile: boxes are
   either aligned or not drawn (never drawn rotated); the « Tenez le téléphone en portrait » hint appears. Note
   whether the frozen still after a tap is shown rotated (known limit R3).
2bis. Record the live refresh period on the slowest phone, and whether the drawer drag stays smooth while a
   snapshot is processed.
3. Hold still 10 s: no new identification happens (boxes do not flicker back to grey). Move to another pile:
   old boxes disappear, new ones are identified.
4. Tap a box → view freezes on that snapshot → fiche opens; back → « Reprendre » returns to live. Nothing appears
   in Inventaire. Tap a box that has just appeared (seen once): it is identified, never stuck on a spinner.
5. Drawer: header shows « ≈ N pièces détectées »; drag and tap both change its height; tapping a row highlights
   the boxes and opens the fiche; an orange badge opens the candidate chooser with the piece's photo on top.
   Android back collapses the drawer, then resumes a frozen view.
6. Switch Explorer ↔ Inventorier five times: the preview never goes black.
7. Réglages → « Explorer en direct » off → an « Analyser » button replaces the automatic scan.

**C. Inventorier (pile)**
1. The 20-piece pile, spread, light table, daylight: shutter → boxes within ≈ 2 s, all identified within ≈ 8 s on
   Wi-Fi. Record: boxes found / 20, pieces with correct part, with correct colour, counts by status
   (green / orange / grey), total time.
2. « Valider » → grouped lines (`3× Brique 2 × 4 …`, French labels), « ≈ » banner, `+ / −` and typed quantity,
   colour change (suggestions first, the piece's photo and measured swatch on top), remove, « Inconnue » → choose
   among candidates (the row shows the photo of the real piece), « Pièce coupée » for a piece cut by the frame,
   orange badge → chooser applied to the whole line. Footer shows « dont N à vérifier » and the number of pieces
   that will be ignored.
3. A line « Couleur à confirmer » disables « Ajouter » with an explanation; « Confirmer {couleur} » (one tap) or
   « Tout confirmer » enables the button.
4. « Ajouter N pièces à Mon inventaire » → visual confirmation, snackbar with « Annuler » for 10 s (« N ajoutées ·
   K ignorées » when some were skipped); undo removes exactly what was added. Add again, rescan the same pile →
   warning « Déjà ajouté depuis cette session ».
4bis. Tap « Reprendre » during a long analysis (40 pieces, slow network): the scanner returns to live at once and
   no late result appears.
5. Repeat 1 on the dark surface, indoors, and with pieces touching: note the degradation (expected: same-colour
   touching pieces merge → « plusieurs pièces ? », corrected with `+ / −`).
6. Same pile, second view angle: counts differ slightly → « ≈ » is justified.

**D. Camera ergonomics and failures**
1. Torch toggles; long-press locks focus (icon changes); on Android note whether the lock has any effect.
2. Patterned surface → guidance banner, no flood of boxes; a single piece is still identified.
3. Airplane mode → shutter: boxes appear grey with « Identification indisponible »; back online → « Réessayer »
   identifies them. The app never freezes or crashes.
4. Pile of ≈ 40 small pieces: app stays responsive; note segmentation time and memory warnings, if any.
5. Leave the Scanner tab and return 10 times; lock/unlock the phone: the preview comes back each time.

**E. Fiche pièce** (needs `catalog-proxy` deployed; otherwise verify the degraded states)
1. Identity block: official name, Design ID, Element ID, colour name + hex, category, dimensions (« — » for a
   Technic pin).
2. « Acheter sur LEGO » opens the browser on Pick a Brick with a query; note whether results show for the element id.
3. Sets list scrolls, « Charger plus » works, year and name filters work, tapping a set shows « ×N ».
4. Proxy unreachable (airplane mode after a first load): cached identity still shown, sets show an error + retry.
5. A piece whose Brickognize id differs from Rebrickable (e.g. round brick 1 × 1 → `3062b`, round plate 1 × 1 →
   `6141`) shows the Rebrickable id once resolved (provisional name first, then swapped).
6. « + Ajouter à une liste » → the list sheet closes, then the undo snackbar is visible for 10 s; the screen has
   a back chevron (card) and no tab bar.

**F. Inventory, lists, export** (airplane mode, guest)
1. Grid: image tiles, yellow quantity badge on the image's top-right corner, `99+` above 99 (type 120 in the
   stepper). **Tile colour matches the brick** (after hydration online) or, offline / before hydration, the tile
   carries a colour dot naming the real colour.
2. List view, grouping by category / colour / list (category titles in French), search « brique », « plaque » and
   with and without accents, colour and category filters; a search with no match shows « Aucun résultat » +
   « Effacer les filtres ».
3. Edit quantity; set to 0 → the actions sheet closes and the undo snackbar is visible, « Annuler » restores it;
   move to another list; « Supprimer » → sheet closes, snackbar visible, undo works.
4. Lists: create (duplicate name refused with a message), rename, delete with confirmation; the last list cannot
   be deleted.
5. Export CSV, JSON and BrickLink XML → share sheet opens with a correctly named file; back in the app the result
   (« N lignes exportées », skipped count for XML) is shown inside the export sheet; open the CSV in a spreadsheet
   (accents intact), validate the XML with BrickLink's wanted-list upload page (do not submit).
6. Fresh install as guest → Listes shows « Mon inventaire ».

**G. Account** (after the user actions of §8.3; use a team e-mail address until custom SMTP is set)
1. Sign-up with an invalid e-mail and a 7-character password → field errors. Valid sign-up → code screen → code
   from the e-mail signs in. Also try « J'ai confirmé via le lien ».
2. Sign out (with a pending change → warning), sign in with password; wrong password → clear message + exits.
3. « Recevoir un code de connexion » → code → signed in.
4. Forgot password with an existing and a non-existing address → identical message; code → new password → signed in.
5. Kill the app, relaunch → still signed in. Leave it > 1 h in the background → still signed in after foreground.
   **Offline cold start**: signed in, airplane mode, set the clock 2 h ahead (or wait > 1 h), cold start → camera
   in < 3 s, still signed in, no « Session expirée » banner, sync shows « Hors ligne »; back online → syncs.
6. Change password, edit pseudo (with an accent: « Élodie »; relaunch → pseudo intact). Delete account (type
   SUPPRIMER; the sheet mentions this device's data and offers « Exporter d'abord ») → back to welcome; signing in
   again fails.
7. Sign up with an already-registered e-mail → VerifyCode offers « Déjà un compte ? Se connecter ».

**H. Sync and merge** (two devices or one device + reinstall)
1. Device A signed in adds 3 × a piece; device B (same account) shows it after foregrounding.
2. Both in airplane mode: A +3, B +2 on the same reference; back online → both show the **sum**.
3. A deletes a reference while B adds 1 offline → after sync both show 1.
4. Guest with local inventory signs in to an account that already has data → prompt; « Fusionner » adds the
   quantities; repeat with « Garder uniquement mon compte » and « Annuler ».
5. Compte shows « synchronisé il y a … », then « Hors ligne — N modification(s) en attente » in airplane mode.
6. Fresh install on device B, sign in directly (no guest data) → exactly one « Mon inventaire » on both devices
   after sync (no duplicate).
7. Sign out while a sync is in flight (toggle airplane mode during the sync): after signing in again, quantities
   are not doubled.
8. Signed in as B on a device holding A's data → prompt; « Conserver ces données (mode sans compte) » keeps them
   as guest data.
9. With `catalog-proxy` unreachable, add a scanned piece while signed in: Compte shows « 1 pièce en attente
   d'identification catalogue »; once the proxy answers, it syncs under its Rebrickable id and device B shows the
   same quantity (not doubled).

**I. Calibration and performance record**
1. Enable Mode Calibration, scan the 20-piece pile, enter the expected list, « Comparer »: record precision,
   recall (target **≥ 0.80**), part-only precision/recall, count error; save and share the JSON to yourself.
2. From the session JSON record `prepareMs`, `segmentMs`, `identifyMs`, `catalogMs`, `brickognizeCalls`, on
   **the slowest Android phone available** too. Go/no-go rule: see §8.1 R2.
3. Compare the share of correct pieces among green (≥ 80 %) and orange boxes: if green is wrong more than 1 time
   in 5, or most correct pieces are orange, `SCORE_CALIBRATION` must be adjusted.

**J. Accessibility pass** (VoiceOver and TalkBack)
1. Every control on Scanner, Review, Inventory, Lists, Compte and the auth screens is reachable and announced in
   French with its role; boxes announce name, colour, percentage and status.
2. System font at the largest non-accessibility size: no clipped text; all targets remain tappable.
3. Greyscale mode: the three confidence levels remain distinguishable.

## 8. Risks, non-goals, user actions, doc updates

### 8.1 Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Segmentation and thresholds were tuned on synthetic images only; real shadows, glare and perspective will lower recall; same-colour touching pieces merge (held-out recall 0.21) | high / medium | guidance text, `suspectMerged` badge, manual boxes, `+ / −`, Calibration mode, tunables in one file |
| R2 | Hermes speed: jitless proxy 442 ms (320 px) / 298 ms (256 px) on a desktop → estimated 0.6–1.2 s of JS per image on a mid-range Android; each live tick also pays capture + thumbnail decode; jank of the drawer | high / medium | single decode per live tick (no work-image re-encode), capture re-encode skipped when ≤ 1920 px, `segmentPileAsync` yields between stages, adaptive live loop (interval up to 6 s, 192 px) instead of self-disabling. **Go/no-go at the gate (I2, slowest Android)**: capture-path `segmentMs` ≤ 1500 ms and live refresh ≤ 6 s → ship as is; otherwise `liveExplorer` defaults to false (one constant in `DEFAULT_SETTINGS`) and `segMaxSide.inventory` drops to 256 — no architectural change. No agent can run Expo Go on a phone, so this cannot be a WP0 spike. |
| R3 | Live overlay misaligned on some Android devices: (a) photo vs preview field of view; (b) Android bakes the last physical orientation into the photo (OrientationEventListener ignores "flat"), so a phone held flat after being in landscape returns a rotated photo | medium / medium | 4:3 picture size (same aspect as the preview), pure cover mapping; `orientationMatches` skips 90°/270° snapshots silently (+ « Tenez le téléphone en portrait » hint); **180° is undetectable from dimensions — known limit**; tap always freezes on the snapshot (boxes consistent with the still, which may then be displayed rotated); setting to disable live; device script B2 |
| R4 | `takePictureAsync` every 2.5 s: preview stutter, shutter sound that cannot be muted in some regions, heat | medium / low–medium | `shutterSound: false`, no animation, adaptive interval, automatic and manual fallback |
| R5 | Brickognize: no SLA, 429 under bursts, "Legacy" endpoints may become metered, ToS grants them rights on uploaded images | medium / high | single interface, pool of 4 + budget + retry, EX_09 states, privacy notice, contact the author (§8.3) |
| R6 | D5 calibration curve wrong on real data → too many/few "acceptée" | medium / medium | constant + tests + device script I3 |
| R7 | Supabase free project paused / functions not deployed / legacy key | high during development / medium | provisional parts, circuit breaker, guest mode independent of Supabase |
| R8 | Rebrickable throttling or IP ban of the function, API "severely overloaded" | low–medium / medium | cache-aside with long TTLs, sequential spaced calls, 5 fallback lookups per request, stale-if-error |
| R9 | Provisional id later resolves to a different Rebrickable id, or collides with an unrelated one; most mould-variant ids need the slow per-id fallback (`part_nums` returned only `3001` of `3001,4073,3062,2412`) | medium / low | provisional part shown at once; pending parts never synced, so `renamePart` only moves unpushed rows (no cross-device double count); suffix probe (step 3b); `bricklink_map_cache`; a `not_found` id is final and synced as is |
| R10 | Unverified APIs: `expo-crypto` AES in Expo Go, `ImageManipulator` shared refs, multipart `fetch` on RN 0.88, `Stack.Protected` redirect details, `@supabase/server` wrapper, `verifyOtp` types | medium / medium | each isolated in one file with a documented fallback (§4.2, §5.3, §3, §6.2, §4.9); gate bundling check; device script |
| R11 | E-mail delivery: built-in SMTP reaches team addresses only (2/hour) | certain until fixed / high for real users | user action U5; sign-up fallback « J'ai confirmé via le lien »; guest mode |
| R12 | Colour errors (white vs light bluish gray, yellow vs bright light orange), no white balance | high / low | « couleur à confirmer », suggestions in the picker, easy correction |
| R13 | Migration 2 additions and both Edge Functions were never executed | medium / medium | additive SQL only; `supabase/tests`; `smoke.sh`; user applies on the dev project first |
| R14 | Nine agents in one tree: contract drift; whole-tree tsc/lint red because of half-written neighbours | medium / medium | stubs with exact signatures, no cross-package edits, own-files-only hand-back checks (§0), shared write gate and scenario table, gate step 5 |
| R15 | Concurrent SQLite writers (user edits vs sync apply) losing increments or failing with "database is locked" | was certain without a gate / high | single `withWrite` queue; read-modify-write inside one callback; tests on the pure parts |

### 8.2 Non-goals for V1

- **Sign in with Apple and Google** (EX_20): not feasible in Expo Go (Apple tokens are issued for Expo Go's
  bundle id; native Google sign-in needs custom native code). No button is shown. Planned for the development
  build phase, both together (Apple is mandatory on iOS as soon as a social login exists).
- True magic-link deep linking in Expo Go (replaced by 6-digit codes; the callback route exists for builds).
- Real-time (≥ 10 fps) box tracking, on-device ML (TFLite/ONNX), any hosted detector, `EXPO_PUBLIC_DETECTOR_URL`.
- Occlusion estimation ("visible à < 40 %"), automatic split of merged pieces, box resize/merge gestures.
- Pinch-to-zoom and tap-to-focus-at-point (not offered by `expo-camera`); zoom control.
- « Sync Wi-Fi uniquement » setting, realtime sync, background sync, shared lists, profiles table.
- Languages other than French; full translation of part names (only the leading words are translated by
  `partLabel`; categories are fully translated).
- Offline identification; guaranteed offline images (expo-image disk cache only).
- Web target; tablets; landscape.
- Importing inventories (CSV/BrickLink XML); minifigures and sets recognition; prices.
- Component/E2E test suites; Sentry or analytics.

### 8.3 User actions (not done by any package; the app degrades gracefully until then)

| # | Action | Unblocks |
|---|---|---|
| U1 | Put the project's **publishable** key in `.env` as `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `catalog-proxy` (rejects the legacy anon key) |
| U2 | Review and apply migration 2: `npx supabase db push` (v3 CLI targets the local stack by default: check the target / `--remote`) | sync, catalogue caches |
| U3 | `npx supabase functions deploy catalog-proxy delete-account --use-api`, then `supabase/functions/catalog-proxy/smoke.sh` | catalogue resolution, fiche, account deletion |
| U4 | `npx supabase config diff`, then `npx supabase config push` (or set in the dashboard: OTP length 6, redirect URLs `brickheap://**` and `exp://**`, the three e-mail templates with `{{ .Token }}`) | e-mail codes (sign-up confirmation, login code, password reset) |
| U5 | Configure a custom SMTP provider (free tier) in Auth settings | e-mails to non-team addresses |
| U6 | E-mail the Brickognize author (contact in their OpenAPI spec) about third-party app use and future API credits | long-term availability |
| U7 | After the gate: run the device script on both phones and report the numbers of section I | threshold tuning |

### 8.4 Doc-update task (WP1)

`docs/FUNCTIONAL_SPECS.md`
- Status line: specs validated for V1; link to this plan.
- EX_01: « Aperçu caméra fluide ; cadres mis à jour par instantanés (toutes les 2–3 s, limite d'Expo Go) ;
  identification asynchrone des pièces stables. »
- RG_03: partial = piece cut by the frame; occlusion not measured in V1.
- RG_04: thresholds apply to the calibrated confidence (`thresholds.ts`); note the interpretation of §4.5: "à vérifier"
  pieces are counted and confirmed by « Ajouter ».
- EX_09: remove « /Hugging Face ».
- EX_11: the exported session contains no image; identification still uses Brickognize.
- EX_13: query = element id when the colour is known, else design id; label « Rechercher sur Pick a Brick ».
- EX_14: quantity shown on demand per set; year/name filters apply to the loaded pages (« {loaded} sur {total}
  sets chargés », one automatic extra page when a filter finds nothing, « Charger plus »).
- EX_12 / EX_15: part names are shown with a French label (leading words translated), the official English name
  stays on the fiche; categories are in French. EX_15: the tile shows the coloured image when known, otherwise a
  colour dot on the image.
- EX_16: the quantity can be typed (tap on the value).
- RG_06: one-tap « Confirmer {couleur} » and « Tout confirmer »; the colour picker shows the photo of the piece.
- RG_08: a list delete is final — items added offline on another device to a deleted list are dropped with it.
- RG_12: offline with an expired token is not an expired session; « Conserver ces données sur cet appareil (mode
  sans compte) » exit. EX_23: deleting the account also deletes this device's local inventory (« Exporter
  d'abord » offered).
- EX_20: V1 = e-mail + password and e-mail code; Apple/Google deferred to the development-build phase.
- RG_11: the three merge choices. RT_02: key in `expo-secure-store`, encrypted session in local storage.
- New rule: parts unknown to the catalogue are kept as provisional references and reconciled later.

`docs/UX_UI_MOCKUPS.md` and `docs/mockups-preview.html`
- A2: remove the Apple and Google buttons; « Recevoir un lien magique » → « Recevoir un code de connexion »;
  add the code-entry screen. A4: « Saisir le code reçu ». A6: remove « Sync Wi-Fi uniquement », add « Explorer en
  direct ». C3: replace « Glissez pour… » by the « ⋯ » actions menu. B1: note the snapshot-based live mode.
- B3 and C1 redrawn **without the tab bar**, and UX §2bis reworded: « La barre d'onglets est masquée sur les écrans
  empilés : validation, fiche pièce, export, réglages, profil. » B3: crop thumbnails on lines to decide, « Confirmer
  {couleur} », footer « dont N à vérifier ».

`docs/ARCHITECTURE_CLOUD.md`
- Diagram and table: detector = on-device pure-JS segmentation; remove TFLite / Hugging Face; Auth = e-mail
  (no anonymous); add `delete-account`; publishable key instead of `anon`.
- Vision pipeline: the D1–D7 pipeline (PNG thumbnail + upng-js, 320 px crops, Brickognize colour first,
  CIEDE2000 cross-check, BrickLink → Rebrickable mapping, provisional parts).
- Data model: migration 2 tables, grants, `public.sync`; "Hors-ligne": delta sync instead of last-write-wins.
- Security: photos go to Brickognize (their ToS), privacy notice in the app.

`docs/DEVICE_SETUP.md`, `README.md`, `CONTRIBUTING.md`, `.env.example` (WP0 for the latter)
- Publishable key name; `supabase db push` + `functions deploy` steps; SMTP note; no detector URL.
- CONTRIBUTING: structure (`src/domain/vision`, `src/domain/pile`, `src/i18n/fr`), thresholds path
  `src/domain/pile/thresholds.ts`, "one string module per area", no Hugging Face lead.
- New `docs/DEVICE_TEST_SCRIPT.md` from §7.4.

## Appendix A — Segmentation algorithm (reference for the WP2 port)

Source to port when available: `docs/research/segment.prototype.js` (copied by WP0 from the research scratchpad;
zero dependencies, typed arrays only). If it is missing, implement from this description. Input: RGBA bytes of a
thumbnail whose long side is ≤ 320 px. N = width × height.

Defaults (`SEGMENT_DEFAULTS`): `ring 0.035`, `kSigma 4.5`, `minTc 0.16`, `minTL 9`, `shadowFrac 0.5`,
`coreFrac 0.25`, `minAreaFrac 0.0012`, `maxAreaFrac 0.55`, `colorSplitDist 0.30`, `lightSplitDist 0.42`,
`colorSplitMinFrac 0.12`, `shapeSeedFrac 0.62`, `shapeSplitRelArea 1.6`, `nestedFrac 0.7`, `pad 0.08`,
`maxDepth 3`.

1. **Per pixel**: CIE Lab (sRGB, D65) and log-chromaticity `c1 = ln(R+12) − ln(G+12)`, `c2 = ln(B+12) − ln(G+12)`
   (shadow-invariant).
2. **Background model**: pixels of the border ring (width `max(2, round(min(w,h) × ring))`). Fit a quadratic
   surface `a + bx + cy + dx² + ey² + fxy` (x, y normalised to −1..1; least squares with a 1e-6 ridge, Gaussian
   elimination with partial pivoting) for L, c1 and c2. Three passes; after passes 1 and 2 keep only ring pixels
   with `|ΔL| ≤ 3σL + 2` and `Δc ≤ 3σC + 0.03`, where `σ = 1.4826 × median(residuals)` (σL on |ΔL|, σC on the
   Euclidean (c1, c2) residual). Quality: `patterned` if `σL > 9 || σC > 0.12`; `textured` if
   `σL > 3.5 || σC > 0.05`; else `plain`.
3. **Foreground**: `TL = max(minTL, kSigma × σL)`, `Tc = max(minTc, kSigma × σC)`. Pixel is foreground if
   `Δc > Tc` or `|ΔL| > TL`. It is a *shadow candidate* if it is foreground only because it is darker
   (`Δc ≤ Tc`, `ΔL < −TL`) and `ΔL > −shadowFrac × L_background`.
4. **Shadow pruning**: 4-connected labelling of the foreground; in each component whose non-candidate ("core")
   pixels are ≥ `coreFrac` of its area, remove the candidates (a grey piece on white is all candidates and is
   kept whole).
5. **Morphology**: open 3×3 (erode then dilate, cross-shaped) then close 3×3; restore border pixels from the
   pre-morphology mask where their inner neighbour is set (so cut-off pieces still touch the edge). Label again;
   keep components with area in `[max(12, round(minAreaFrac × N)), maxAreaFrac × N]`.
6. **Split** (recursive, depth ≤ `maxDepth`, only for blobs ≥ 2 × min area):
   - *Colour split*: 2-means (8 iterations, seeds = point farthest from the mean, then point farthest from it) on
     `(a, b) / (L + 25)`; accept if centroid distance ≥ `colorSplitDist`, each cluster ≥
     `max(minArea, colorSplitMinFrac × n)` and the largest connected region of each cluster holds ≥ 75 % of it.
     If rejected and the blob is achromatic (median chroma < 12): 2-means on `L / 100` with distance ≥
     `lightSplitDist`. Result parts = connected regions ≥ min area.
   - *Shape split*, only if the scene has ≥ 3 valid blobs and this blob's area ≥ `shapeSplitRelArea` × median
     blob area: chamfer distance transform (1 / 1.414) inside the blob, `M` = max; skip if `M < 3`; seeds =
     connected regions (≥ 3 px) of `{DT ≥ shapeSeedFrac × M}`; require 2–4 seeds; grow seeds by multi-source BFS
     (4-connected, geodesic); keep parts ≥ min area, need ≥ 2.
7. **Nested merge**: smallest first, merge a piece into a larger one when the intersection of their tight boxes is
   ≥ `nestedFrac` of the smaller box.
8. **Boxes**: tight box; `partial` when it lies within 1 px of any image border; padded box = tight box grown by
   `round(pad × max(w, h))` px, clamped; `suspectMerged` when there are ≥ 3 boxes and area > 3 × median area;
   output normalised, sorted by y then x.
9. **Dominant colour** of a mask: keep pixels whose L is between the 40th and 90th percentile (drops shaded
   faces and glare); if the median chroma > 12 also drop pixels with chroma < half the median; fewer than 5
   pixels left → use all; result = per-channel median Lab (+ sRGB conversion).

Notes for the port: typed-array `sort()` without comparator is numeric (relied upon by `median`); keep the
`Float32Array`/`Int32Array` buffers; the function allocates O(N) memory a few times, which is fine at 320 px
(76 800 pixels); do not add a per-pixel object anywhere.


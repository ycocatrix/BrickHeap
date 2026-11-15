// Every tunable of the vision pipeline in one place (§4.4). Pure constants.

/** Every tunable of the pipeline in one place. */
export const VISION = {
  picture: { longSide: 1920, liveQuality: 0.6, captureQuality: 0.85 },
  /** Captures: re-encode only when the photo's long side exceeds this. Live snapshots are never re-encoded. */
  workMaxSide: 1920,
  segMaxSide: { inventory: 320, explore: 256, exploreMin: 192 },
  crop: { outSide: 320, quality: 0.8, minSourceSide: 40 }, // px in the work image
  wholeImageSide: 640,
  nmsIou: 0.6, // RG_03
  trackIou: 0.5, // RG_02
  maxBoxes: 60,
  brickognize: { concurrency: 4, maxRetries: 3, timeoutMs: 10000, topKItems: 5, topKColors: 3, minSimilarity: 0.25, budgetPerMinute: 90 },
  live: { intervalMs: 2500, maxIntervalMs: 6000, slowCycleMs: 2200, stableHits: 2, maxMisses: 1, maxFailures: 3 },
} as const;

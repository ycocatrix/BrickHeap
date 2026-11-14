// Only EXPO_PUBLIC_* values are bundled in the app: never put a secret here.
// Each variable must be read with a literal `process.env.EXPO_PUBLIC_…` expression (inlined at build time).
export const env: { supabaseUrl: string; supabaseKey: string; brickognizeUrl: string } = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  // Publishable key first; the legacy anon key is only a fallback (catalog-proxy rejects it).
  supabaseKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
  brickognizeUrl: process.env.EXPO_PUBLIC_BRICKOGNIZE_URL || 'https://api.brickognize.com',
};

export function isSupabaseConfigured(): boolean {
  return /^https:\/\/.+\.supabase\.co$/.test(env.supabaseUrl) && env.supabaseKey.length > 20;
}

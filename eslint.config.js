// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // supabase/functions is Deno code (URL / npm: imports); docs/ holds reference material only.
    ignores: ['dist/*', 'supabase/functions/**', 'docs/**', 'coverage/**'],
  },
]);

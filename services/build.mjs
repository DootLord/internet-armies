// Bundle a service (run from its folder) into dist/main.js: one file with every
// dependency inlined, including @eden/shared and @eden/kit. The runtime image
// then needs no node_modules at all, which keeps it small and fast to pull.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // Optional native accelerators that libraries try to load and happily live without.
  external: ['pg-native', 'msgpackr-extract', 'bufferutil', 'utf-8-validate'],
  // Some dependencies are CommonJS and call require(); give the ESM bundle a real one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

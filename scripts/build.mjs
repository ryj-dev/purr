// Bundles the service and the Electron shell. The web UI is built by Vite (npm run build:web).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: 'linked', logLevel: 'warning', legalComments: 'none' };

await Promise.all([
  // the service + CLI, run by the app's runtime (ELECTRON_RUN_AS_NODE) or by node directly
  build({
    ...common, entryPoints: ['src/server/cli.ts'], outfile: 'dist/server/cli.mjs', format: 'esm',
    define: { 'process.env.PURR_BUILD_VERSION': JSON.stringify(version) },
    banner: { js: "import { createRequire as __purrRequire } from 'node:module'; const require = __purrRequire(import.meta.url);" },
  }),
  build({ ...common, entryPoints: ['desktop/main.ts'], outfile: 'dist/desktop/main.cjs', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['desktop/preload.ts'], outfile: 'dist/desktop/preload.cjs', format: 'cjs', external: ['electron'] }),
]);
console.log(`built purr ${version}: dist/server/cli.mjs, dist/desktop/{main,preload}.cjs`);

import * as esbuild from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
/** `--metafile=<path>`: build nothing, only write esbuild's list of bundled files there (for `task notices`). */
const metafile = process.argv.find((a) => a.startsWith('--metafile='))?.slice('--metafile='.length);

/** Prints build start/finish lines so VS Code's $esbuild-watch problem matcher knows when F5 can launch. */
const problemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

/** sql.js loads its WebAssembly binary at runtime from next to dist/extension.js. */
const copySqlWasmPlugin = {
  name: 'copy-sql-wasm',
  setup(build) {
    build.onEnd(async () => {
      await mkdir('dist', { recursive: true });
      await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
    });
  },
};

/**
 * Libraries bundled as their own files next to dist/extension.js, each read only when the code that lazily imports
 * it first runs (architecture.md): VS Code never parses a database library you don't use. Flat in dist/, so sql.js
 * still finds sql-wasm.wasm beside it. Import specifier → [output name, entry point].
 */
const LIBRARY_BUNDLES = {
  pg: ['pg', 'pg'],
  'mysql2/promise': ['mysql2', 'mysql2/promise'],
  ssh2: ['ssh2', 'ssh2'],
  'sql.js': ['sqljs', 'sql.js'],
  yaml: ['yaml', 'yaml'],
  // The module, not sql-formatter itself: it imports only the dialects DB Deck uses.
  './formatSql': ['format', 'src/query/formatSql.ts'],
  './sqlserverLib': ['sqlserver', 'src/drivers/sqlserverLib.ts'],
};

/** In the extension bundle, `import('pg')` becomes `require('./pg.js')` of the separate file (and so on). */
const separateLibrariesPlugin = {
  name: 'separate-libraries',
  setup(build) {
    for (const [module, [name]] of Object.entries(LIBRARY_BUNDLES)) {
      const filter = new RegExp(`^${module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`);
      build.onResolve({ filter }, () => ({ path: `./${name}.js`, external: true }));
    }
  },
};

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  ...(metafile ? { metafile: true, write: false } : {}),
};

// pg-native is an optional native addon pg only loads if asked; cloudflare:sockets is for Workers only.
// ssh2 tries its optional native crypto (sshcrypto.node) and cpu-features inside try/catch: left out of the
// bundle, those requires fail and ssh2 uses its pure-JavaScript crypto, on every platform (core.md rule 1).
const NODE_EXTERNALS = ['vscode', 'pg-native', 'cloudflare:sockets', 'cpu-features', '*.node'];

// The extension itself, run by VS Code's Node.
const extension = await esbuild.context({
  ...shared,
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: NODE_EXTERNALS,
  // Lazy `await import('pg')` of a separate file becomes a plain `require('./pg.js')` where it runs, the form
  // VS Code's extension host loads most safely; nothing is required before the code that needs it.
  supported: { 'dynamic-import': false },
  plugins: metafile ? [separateLibrariesPlugin] : [separateLibrariesPlugin, copySqlWasmPlugin, problemMatcherPlugin],
});

// The libraries in their own files (LIBRARY_BUNDLES): dist/pg.js, dist/mysql2.js, dist/sqlserver.js, …
const libraries = await esbuild.context({
  ...shared,
  entryPoints: Object.fromEntries(Object.values(LIBRARY_BUNDLES)),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  external: NODE_EXTERNALS,
  plugins: metafile ? [] : [problemMatcherPlugin],
});

// The webview scripts, run inside webviews (a browser): the results grid and the forms (connection, dump, run file).
// Each emits <name>.js and <name>.css.
const webview = await esbuild.context({
  ...shared,
  entryPoints: ['src/webview/results.ts', 'src/webview/connectionForm.ts', 'src/webview/dumpForm.ts', 'src/webview/runScriptForm.ts', 'src/webview/importForm.ts', 'src/webview/tableDesignForm.ts', 'src/webview/dangerForm.ts', 'src/webview/explainView.ts', 'src/webview/serverView.ts', 'src/webview/diagram.ts', 'src/webview/compareForm.ts', 'src/webview/mockForm.ts'],
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist/webview',
  plugins: metafile ? [] : [problemMatcherPlugin],
});

const contexts = [extension, libraries, webview];
if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  const results = await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  if (metafile) {
    const inputs = Object.assign({}, ...results.map((r) => r.metafile.inputs));
    await writeFile(metafile, JSON.stringify({ inputs }));
  }
}

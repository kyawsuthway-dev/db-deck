import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
};

// The extension itself, run by VS Code's Node.
const extension = await esbuild.context({
  ...shared,
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  // pg-native is an optional native addon pg only loads if asked; cloudflare:sockets is for Workers only.
  // ssh2 tries its optional native crypto (sshcrypto.node) and cpu-features inside try/catch: left out of the
  // bundle, those requires fail and ssh2 uses its pure-JavaScript crypto, on every platform (core.md rule 1).
  external: ['vscode', 'pg-native', 'cloudflare:sockets', 'cpu-features', '*.node'],
  plugins: [copySqlWasmPlugin, problemMatcherPlugin],
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
  plugins: [problemMatcherPlugin],
});

const contexts = [extension, webview];
if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}

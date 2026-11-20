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
  external: ['vscode', 'pg-native', 'cloudflare:sockets'],
  plugins: [copySqlWasmPlugin, problemMatcherPlugin],
});

// The results grid script, run inside the webview (a browser). Emits results.js and results.css.
const webview = await esbuild.context({
  ...shared,
  entryPoints: ['src/webview/results.ts'],
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

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const root = __dirname;
fs.rmSync(path.join(root, 'out/extension.cjs'), { force: true });

const jaclyAlias = {
  name: 'jacly-source',
  setup(build) {
    build.onResolve({ filter: /^@jaculus\/jacly\/(.+)$/ }, (args) => ({
      path: (() => {
        const directory = path.join(root, '.jacly/packages/jacly/src', args.path.slice('@jaculus/jacly/'.length));
        const tsxEntry = path.join(directory, 'index.tsx');
        return fs.existsSync(tsxEntry) ? tsxEntry : path.join(directory, 'index.ts');
      })(),
    }));
  },
};

const reactDedupe = {
  name: 'react-dedupe',
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({
      path: require.resolve(args.path, { paths: [root] }),
    }));
  },
};

Promise.all([
  esbuild.build({
    entryPoints: ['scripts/extension-entry.ts'], bundle: true, platform: 'node', format: 'esm',
    outfile: 'out/extension.js', external: ['vscode'], packages: 'external', sourcemap: !production,
    minify: production,
  }),
  esbuild.build({
    entryPoints: ['.jacly/extensions/vscode/src/webview/main.tsx'], bundle: true, platform: 'browser',
    format: 'esm', outfile: 'dist/webview.js', loader: { '.css': 'css' }, sourcemap: !production,
    minify: production, plugins: [jaclyAlias, reactDedupe],
  }),
]).catch(() => process.exit(1));

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
const read = (file: string) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
const version = (name: string) => read(`node_modules/${name}/package.json`).version as string;

if (!existsSync(resolve(root, 'node_modules/@comunica/query-sparql-rdfjs-lite/lib/index.js'))) {
  throw new Error('Comunica is not built and linked; run `npm run prepare` (npm install with arguments removes the links).');
}

// The adapter's own dependencies (n3, rdf-stores) share packages with the Comunica checkout. An application
// installing both would get one copy of each, so packages present at the same version in both trees are deduped.
function sharedPackages(): string[] {
  const list = (dir: string) => readdirSync(dir).flatMap(name => name.startsWith('@') ?
    readdirSync(resolve(dir, name)).map(sub => `${name}/${sub}`) :
    name.startsWith('.') ? [] : [ name ]);
  const versionIn = (dir: string, name: string) => {
    try {
      return JSON.parse(readFileSync(resolve(dir, name, 'package.json'), 'utf8')).version;
    } catch {
      return undefined;
    }
  };
  const project = resolve(root, 'node_modules');
  const comunica = resolve(root, '.cache/comunica/node_modules');
  return list(project).filter(name => !name.startsWith('@comunica/') &&
    versionIn(project, name) !== undefined && versionIn(project, name) === versionIn(comunica, name));
}

// Embedded in both pages, so every raw result names the exact builds it ran.
const build = {
  builtAt: new Date().toISOString(),
  comunica: read('.cache/comunica-build.json'),
  oxigraph: version('oxigraph'),
  n3: version('n3'),
  rdfStores: version('rdf-stores'),
  vite: version('vite'),
};

// One build, two entries: both pages get identical transform and minify settings.
// Lists the modules in every chunk (dist/bundle-modules.json), so bundle sizes can be attributed.
const moduleReport: Plugin = {
  name: 'bench-module-report',
  generateBundle(_options, bundle) {
    const chunks: Record<string, { facadeModuleId: string | null; modules: Record<string, number> }> = {};
    for (const [ file, item ] of Object.entries(bundle)) {
      if (item.type === 'chunk') {
        chunks[file] = {
          facadeModuleId: item.facadeModuleId ? relative(root, item.facadeModuleId) : null,
          modules: Object.fromEntries(Object.entries(item.modules)
            .map(([ id, info ]) => [ relative(root, id), info.renderedLength ])),
        };
      }
    }
    this.emitFile({ type: 'asset', fileName: 'bundle-modules.json', source: JSON.stringify(chunks, null, 1) });
  },
};

export default defineConfig({
  plugins: [ moduleReport ],
  root: resolve(root, 'src/pages'),
  base: './',
  define: { __BENCH_BUILD__: JSON.stringify(build) },
  resolve: { dedupe: sharedPackages() },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    manifest: true,
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 10_000,
    rollupOptions: {
      input: {
        comunica: resolve(root, 'src/pages/comunica.html'),
        oxigraph: resolve(root, 'src/pages/oxigraph.html'),
      },
    },
  },
});

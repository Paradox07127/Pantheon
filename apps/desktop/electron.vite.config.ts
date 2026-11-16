import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const webRoot = fileURLToPath(new URL('../web', import.meta.url));
const webVersion = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8')).version;

export default defineConfig({
  main: {
    plugins: [
      {
        name: 'visual-libraries',
        async buildStart() {
          const entry = path.join(import.meta.dirname, 'visual-libraries.js');
          await build({
            configFile: false,
            root: webRoot,
            plugins: [
              {
                name: 'visual-library-entry',
                resolveId(id, importer) {
                  if (id === entry) return entry;
                  if (importer === entry) return this.resolve(id, path.join(webRoot, 'index.html'));
                },
                load(id) {
                  if (id === entry)
                    return `
export * as vega from 'vega';
export * as vegaLite from 'vega-lite';
export { default as vegaEmbed } from 'vega-embed';
export * as vegaInterpreter from 'vega-interpreter';
export * as LightweightCharts from 'lightweight-charts';
export { default as mermaid } from 'mermaid';
export * as dagre from '@dagrejs/dagre';
export * as ReactFlow from '@xyflow/react';
`;
                },
              },
            ],
            build: {
              outDir: path.join(import.meta.dirname, 'out/visual'),
              emptyOutDir: true,
              lib: {
                entry,
                name: 'PantheonCharts',
                formats: ['iife'],
                fileName: () => 'charts.js',
              },
            },
          });
        },
      },
      {
        // The main process reads its icons from out/main/app-icons at run time.
        name: 'app-icons',
        generateBundle() {
          const icons = path.join(import.meta.dirname, 'src/main/app-icons');
          for (const file of readdirSync(icons, { recursive: true, withFileTypes: true })) {
            if (!file.isFile()) continue;
            const full = path.join(file.parentPath, file.name);
            this.emitFile({
              type: 'asset',
              fileName: path.posix.join('app-icons', ...path.relative(icons, full).split(path.sep)),
              source: readFileSync(full),
            });
          }
        },
      },
    ],
    // A packaged app has no node_modules beside its main bundle.
    build: { externalizeDeps: { exclude: ['@pantheon/protocol'] } },
  },
  preload: {
    // Sandboxed preload scripts cannot run as ESM.
    build: { rolldownOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    root: webRoot,
    resolve: { alias: { '@': path.join(webRoot, 'src') } },
    define: { __WEB_VERSION__: JSON.stringify(webVersion) },
    // electron-vite turns minify off for the renderer unless it is set here.
    build: { minify: true, rolldownOptions: { input: path.join(webRoot, 'index.html') } },
    plugins: [react(), tailwindcss()],
  },
});

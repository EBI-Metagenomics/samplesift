import { defineConfig } from 'vite';

// Anywidget imports its module from a blob URL, without a static asset server.
export default defineConfig({
  resolve: {
    alias: {
      'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url':
        'maplibre-gl/dist/maplibre-gl-worker.mjs?url&inline',
    },
  },
  build: {
    outDir: '../../../src/samplesift/jupyter/static/dist',
    emptyOutDir: true,
    lib: { entry: 'jupyter.js', formats: ['es'], fileName: () => 'widget.js' },
    rolldownOptions: { output: { codeSplitting: false } },
    sourcemap: true,
    target: 'es2022',
  },
});

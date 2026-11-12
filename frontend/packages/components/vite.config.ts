import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const target = process.env.SAMPLESIFT_API_TARGET || loadEnv(mode, process.cwd(), 'SAMPLESIFT_').SAMPLESIFT_API_TARGET || 'http://127.0.0.1:8002';
  return {
    base: './',
    // Discover lazy form widgets before an embedded notebook imports the component.
    optimizeDeps: { include: ['@golemui/gui-lit'] },
    server: {
      cors: {
        origin: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
        methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS', 'QUERY'],
      },
      proxy: { '/samplesift': { target, changeOrigin: true } },
    },
    build: {
      lib: {
        entry: { 'sample-sift': 'src/index.ts', data: 'src/data/index.ts' },
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      sourcemap: true,
      target: 'es2022',
    },
  };
});

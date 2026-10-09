import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/web'),
  // Vite would otherwise look for `src/web/public`. Pointing it at the repo
  // root keeps static assets (favicon, manifest, icons) where someone opening
  // this repo expects to find them, rather than buried inside the SPA source.
  publicDir: r('./public'),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@web': r('./src/web'),
    },
  },
  build: {
    // Workers Static Assets serves this directory directly.
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep the initial payload small — this app is meant to run on cheap
        // connections and the Workers free tier.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('leaflet')) return 'map';
            if (id.includes('recharts') || id.includes('d3-')) return 'charts';
            if (id.includes('react-router')) return 'router';
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/setup': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
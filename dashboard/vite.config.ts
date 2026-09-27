import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, API + WebSocket calls are proxied to the backend so the dashboard can use relative URLs.
// Set VITE_API_TARGET if the backend runs on another machine.
const target = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
});

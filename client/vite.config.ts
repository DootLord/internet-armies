import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the backend runs in Docker (docker compose up); its web entrypoint on :8080
    // already routes these paths to the right service, exactly as in production.
    proxy: {
      '/auth': 'http://localhost:8080',
      '/.well-known': 'http://localhost:8080',
      '/socket.io': { target: 'ws://localhost:8080', ws: true },
    },
  },
});

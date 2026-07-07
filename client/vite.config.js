import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Vite 5+ blocks unknown Host headers by default ("Blocked request.
    // This host ... is not allowed."). Byron accesses HQ via Tailscale
    // (https://bigbai.tail136908.ts.net:8443 → Caddy → here) and via
    // LAN (https://192.168.1.168:8443 → Caddy → here), so we need to
    // allow both names in addition to the bare IP. Without these,
    // proxied requests via the HTTPS front get a 403 from Vite itself.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'bigbai.tail136908.ts.net',
      'bigbai.lan',
      '100.96.13.84',   // Tailscale IPv4
      '192.168.1.168',  // LAN IPv4
    ],
    proxy: {
      '/api': 'http://localhost:5050',
    },
  },
});

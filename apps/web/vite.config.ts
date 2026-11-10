import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API is proxied under /api so the browser sees one origin and needs no cross-origin rules.
export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": { target: process.env.TIGERIS_API_URL ?? "http://127.0.0.1:3000", rewrite: p => p.replace(/^\/api/, "") } } },
  build: { outDir: "dist", sourcemap: true },
});

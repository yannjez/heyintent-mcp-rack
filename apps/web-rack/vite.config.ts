import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_ORIGIN ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in development: auth cookies, OAuth pages and MCP endpoints
    // all go through the Vite dev server.
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/mcp": { target: api, changeOrigin: false },
      "/.well-known": { target: api, changeOrigin: false },
      "/health": { target: api, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

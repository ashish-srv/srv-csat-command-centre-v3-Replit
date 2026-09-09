import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only. A leading dot permits the domain and all of its subdomains,
    // so Replit's generated preview hostname may change without a code edit.
    // Production is served from dist/ and never uses this Vite server.
    allowedHosts: [".replit.dev", ".trycloudflare.com"]
  },
  build: {
    outDir: "dist",
    sourcemap: false
  }
});

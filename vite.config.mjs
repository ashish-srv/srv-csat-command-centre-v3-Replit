import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only. Vite blocks unrecognised hostnames, which stops a Cloudflare
    // tunnel from reaching the dev server. Production is served from dist/
    // and never uses this.
    allowedHosts: [".trycloudflare.com"]
  },
  build: {
    outDir: "dist",
    sourcemap: false
  }
});

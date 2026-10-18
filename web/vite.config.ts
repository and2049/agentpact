import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Dev: the API lives on the Bun server (default :3000); the client is served by Vite on :5174.
const api = process.env.API_ORIGIN ?? "http://localhost:3000"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    proxy: Object.fromEntries(["/api", "/auth", "/me", "/logout", "/health"].map((p) => [p, { target: api, changeOrigin: false }])),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})

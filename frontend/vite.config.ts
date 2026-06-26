import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const apiTarget = process.env.GOCAM_API_TARGET ?? "http://127.0.0.1:8484"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
})

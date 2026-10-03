import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwind()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5317,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: false } },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwind()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5317,
    // The API runs on PORT too (`npm run dev` starts both): a branch opened in the Vista talks to
    // its own server, never to the Trellai on 4317.
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 4317}`, changeOrigin: false } },
  },
});

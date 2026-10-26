import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "path";

const API_PORT = process.env.PORT || "7331";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/web"),
  plugins: [react(), tailwind()],
  build: {
    outDir: path.resolve(import.meta.dirname, "public"),
    emptyOutDir: false, // legacy.html lives there too
    cssCodeSplit: false, // Keep the approved cascade loaded before deferred screens mount.
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "styles", test: /\.css$/ }] } },
    },
  },
  server: {
    port: 7332,
    proxy: { "/api": `http://127.0.0.1:${API_PORT}` },
  },
});

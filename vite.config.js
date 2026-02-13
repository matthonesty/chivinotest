import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/slabcloud-proxy": {
        target: "https://slabcloud.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/slabcloud-proxy/, ""),
      },
    },
  },
  preview: {
    proxy: {
      "/slabcloud-proxy": {
        target: "https://slabcloud.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/slabcloud-proxy/, ""),
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        nativeViewer: resolve(__dirname, "native-viewer/index.html"),
      },
    },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The API + PeerJS signaling live on the backend (default :8787).
const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:8787";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest (not generateSW) so we can handle `push` and
      // `notificationclick` ourselves in src/sw.ts. The SW source is picked up
      // from srcDir + filename (it compiles to dist/sw.js).
      strategies: "injectManifest",
      registerType: "autoUpdate",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      includeAssets: ["favicon.svg", "icons/*.png"],
      manifest: {
        name: "PeerCast",
        short_name: "PeerCast",
        description: "Watch and broadcast screens peer-to-peer.",
        theme_color: "#0ea5e9",
        background_color: "#0b1220",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/peerjs": { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});

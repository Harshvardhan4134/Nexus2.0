import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "node:url";

const nexusAgentDir = path.dirname(fileURLToPath(import.meta.url));
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT ?? "5173";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

/** Match the API server (same default as api-server PORT fallback). */
const apiProxyTarget =
  process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";

/**
 * Vite's http-proxy can buffer or break SSE unless we avoid compressed upstream
 * responses and strip encoding hints on event-stream bodies.
 */
const apiProxy = {
  target: apiProxyTarget,
  changeOrigin: true,
  configure(proxy: import("http-proxy").Server) {
    proxy.on("proxyReq", (proxyReq) => {
      proxyReq.setHeader("Accept-Encoding", "identity");
    });
    proxy.on("proxyRes", (proxyRes) => {
      const ct = proxyRes.headers["content-type"];
      if (ct && String(ct).includes("text/event-stream")) {
        delete proxyRes.headers["content-encoding"];
      }
    });
  },
};

export default defineConfig({
  /** Load `Nexus3,0/.env` (PORT, BASE_PATH, etc.) when the file lives above `nexus3.0/` */
  envDir: path.resolve(nexusAgentDir, "../../.."),
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": apiProxy,
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": apiProxy,
    },
  },
});

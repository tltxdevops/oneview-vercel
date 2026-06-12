import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const rawBase = env.VITE_APP_BASE_PATH?.trim() ?? "";
  const normalizedBase = rawBase
    ? `/${rawBase.replace(/^\/+/, "").replace(/\/+$/, "")}`
    : "";
  const base = normalizedBase ? `${normalizedBase.replace(/\/+$/, "")}/` : "/";

  // HMR config: keep WS endpoint under the same base (e.g., /noc/@vite) so we don't need root (/) proxying
  // If VITE_DEV_SERVER_ORIGIN is provided (e.g., https://devops.teletex.com.br), use it to set host/protocol/port
  let hmr: Record<string, unknown> | undefined;
  const hmrPath = `${normalizedBase || ""}/@vite` || "/@vite";
  const origin = env.VITE_DEV_SERVER_ORIGIN?.trim();
  if (origin) {
    try {
      const u = new URL(origin);
      const isHttps = u.protocol === "https:";
      hmr = {
        protocol: isHttps ? "wss" : "ws",
        host: u.hostname,
        // If explicit port present in origin, use it; otherwise default 443/80 for https/http
        clientPort: u.port ? Number(u.port) : isHttps ? 443 : 80,
        path: hmrPath,
      };
    } catch {
      // Fallback: at least set the path if parsing fails
      if (normalizedBase) {
        hmr = { path: hmrPath };
      }
    }
  } else if (normalizedBase) {
    // No explicit origin; still force HMR to live under the base path
    hmr = { path: hmrPath };
  }

  return {
    base,
    server: {
      host: "::",
      port: 6565,
      allowedHosts: ["devops.teletex.com.br", "noc.teletex.com.br", "noc.teletexdev.com.br"],
      origin: env.VITE_DEV_SERVER_ORIGIN || undefined,
      hmr,
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY_TARGET || "http://localhost:8000",
          changeOrigin: true,
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});

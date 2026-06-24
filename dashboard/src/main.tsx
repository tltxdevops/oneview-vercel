import "./index.css";
import { isDemoMode } from "@/lib/demo-mode";

declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string | undefined>;
  }
}

async function loadRuntimeConfig() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const response = await fetch("/api/auth/config", {
      cache: "no-store",
    });

    if (!response.ok) {
      return;
    }

    const config = (await response.json()) as Record<string, string | undefined>;
    const nonEmptyConfig = Object.fromEntries(
      Object.entries(config).filter(([, value]) => value && value.trim().length > 0),
    );

    window.__APP_CONFIG__ = {
      ...(window.__APP_CONFIG__ ?? {}),
      ...nonEmptyConfig,
    };
  } catch {
    // Local frontend-only development can still rely on VITE_* variables.
  }
}

async function bootstrap() {
  if (!isDemoMode) {
    await loadRuntimeConfig();
  }

  const [{ createRoot }, { default: App }, { AuthProvider }] = await Promise.all([
    import("react-dom/client"),
    import("./App.tsx"),
    import("@/context/AuthContext"),
  ]);

  createRoot(document.getElementById("root")!).render(
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}

bootstrap();

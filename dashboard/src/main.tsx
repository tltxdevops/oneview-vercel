import "./index.css";

declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string | undefined>;
  }
}

const RUNTIME_CONFIG_KEYS = [
  "ONEVIEW_READ_ONLY_MODE",
  "VITE_AUTH_MODE",
  "VITE_AZURE_CLIENT_ID",
  "VITE_AZURE_TENANT_ID",
  "VITE_AZURE_AUTHORITY",
  "VITE_AZURE_REDIRECT_URI",
  "VITE_AZURE_REDIRECT_URI_LOCAL",
  "VITE_AZURE_POST_LOGOUT_URI",
  "VITE_AZURE_POST_LOGOUT_URI_LOCAL",
  "VITE_AZURE_SCOPES",
  "VITE_MSAL_LOG_LEVEL",
] as const;

function readBuildTimeConfig() {
  const env = import.meta.env as Record<string, string | undefined>;

  return Object.fromEntries(
    RUNTIME_CONFIG_KEYS
      .map((key) => [key, env[key]?.trim()] as const)
      .filter(([, value]) => value && value.length > 0),
  );
}

function mergeAppConfig(config: Record<string, string | undefined>) {
  if (typeof window === "undefined") {
    return;
  }

  window.__APP_CONFIG__ = {
    ...(window.__APP_CONFIG__ ?? {}),
    ...config,
  };
}

async function loadRuntimeConfig() {
  if (typeof window === "undefined") {
    return;
  }

  const buildTimeConfig = readBuildTimeConfig();

  if (import.meta.env.DEV && Object.keys(buildTimeConfig).length > 0) {
    mergeAppConfig(buildTimeConfig);
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

    mergeAppConfig(nonEmptyConfig);
  } catch {
    // Local frontend-only development can still rely on VITE_* variables.
    mergeAppConfig(buildTimeConfig);
  }
}

async function bootstrap() {
  await loadRuntimeConfig();

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

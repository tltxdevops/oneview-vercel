import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { AccountInfo } from "@azure/msal-browser";
import {
  msalInstance,
  loginRequest,
  graphConfig,
  postLogoutRedirectUri,
  isSsoEnvironmentReady,
  hasConfiguredClient,
  hasConfiguredTenant,
  hasSecureCryptoSupport,
  isRunningInSecureContext,
} from "@/lib/auth/msal";

type AuthUser = {
  id: string | null;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  jobTitle?: string;
  photo?: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  error?: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  acquireToken: (scopes?: string[]) => Promise<string | null>;
};

type GraphProfile = {
  id?: unknown;
  mail?: unknown;
  userPrincipalName?: unknown;
  displayName?: unknown;
  givenName?: unknown;
  surname?: unknown;
  jobTitle?: unknown;
};

const STORAGE_KEY = "oneview-auth-user";
const MSAL_TIMEOUT_MS = 15_000;
const GRAPH_PROFILE_TIMEOUT_MS = 8_000;
const GRAPH_PHOTO_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} excedeu ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function getErrorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      name: asString(record.name),
      message: asString(record.message) || "Falha ao inicializar autenticação SSO",
      stack: asString(record.stack),
    };
  }

  return {
    name: undefined,
    message: String(error || "Falha ao inicializar autenticação SSO"),
    stack: undefined,
  };
}

function readStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch (error) {
    console.warn("[auth] Falha ao ler usuário armazenado", error);
    return null;
  }
}

function persistUser(user: AuthUser | null) {
  if (typeof window === "undefined") return;
  try {
    if (user) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.warn("[auth] Falha ao persistir usuário", error);
  }
}

async function fetchGraphProfile(token: string) {
  const response = await fetch(graphConfig.userInfo, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Erro Graph /me: ${response.status}`);
  }

  return response.json();
}

async function fetchGraphPhoto(token: string): Promise<string | undefined> {
  const response = await fetch(graphConfig.photo, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "image/*",
      "Cache-Control": "no-cache",
    },
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    console.warn("[auth] Falha ao buscar foto do Graph", response.status, response.statusText);
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 =
    (typeof window !== "undefined" && typeof window.btoa === "function")
      ? window.btoa(binary)
      : typeof Buffer !== "undefined"
        ? Buffer.from(binary, "binary").toString("base64")
        : "";

  if (!base64) {
    return undefined;
  }

  return `data:${contentType};base64,${base64}`;
}

function normalizeUser(account: AccountInfo, profile?: GraphProfile, photo?: string): AuthUser {
  const claims = account.idTokenClaims ?? {};
  const emailFromClaims = (claims.email as string) || (claims.preferred_username as string) || account.username;
  const profileMail = asString(profile?.mail);
  const userPrincipal = asString(profile?.userPrincipalName);

  const email = emailFromClaims || profileMail || userPrincipal || "";
  const displayName =
    asString(profile?.displayName) ||
    (typeof claims.name === "string" && claims.name) ||
    account.name ||
    email ||
    "Usuário";

  return {
    id: asString(profile?.id) || account.localAccountId || null,
    name: displayName,
    email,
    firstName: asString(profile?.givenName) || (claims.given_name as string | undefined),
    lastName: asString(profile?.surname) || (claims.family_name as string | undefined),
    username: userPrincipal || account.username,
    jobTitle: asString(profile?.jobTitle),
    photo,
  };
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const environmentError = useMemo(() => {
    if (!hasConfiguredClient || !hasConfiguredTenant) {
      return "Configuração do Azure AD ausente. Preencha VITE_AZURE_CLIENT_ID e VITE_AZURE_TENANT_ID.";
    }
    if (!hasSecureCryptoSupport || !isRunningInSecureContext) {
      return "A autenticação SSO exige acesso via HTTPS (ou localhost) para habilitar o módulo de criptografia do navegador.";
    }
    return null;
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadUser = useCallback(async () => {
    if (!msalInstance || !isSsoEnvironmentReady) {
      if (!isMountedRef.current) return;
      setUser(null);
      persistUser(null);
      setError(environmentError);
      setIsLoading(false);
      return;
    }

    const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0] ?? null;

    if (!account) {
      if (!isMountedRef.current) return;
      setUser(null);
      persistUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const silentResult = await withTimeout(
        msalInstance.acquireTokenSilent({
          ...loginRequest,
          account,
        }),
        MSAL_TIMEOUT_MS,
        "acquireTokenSilent",
      );

      const [profile, photo] = await Promise.all([
        withTimeout(fetchGraphProfile(silentResult.accessToken), GRAPH_PROFILE_TIMEOUT_MS, "Graph /me").catch((graphError) => {
          console.warn("[auth] Falha ao carregar perfil do Graph", graphError);
          return undefined;
        }),
        withTimeout(fetchGraphPhoto(silentResult.accessToken), GRAPH_PHOTO_TIMEOUT_MS, "Graph photo").catch(() => undefined),
      ]);

      if (!isMountedRef.current) return;

      const normalized = normalizeUser(account, profile, photo);
      setUser(normalized);
      persistUser(normalized);
      setError(null);
    } catch (err) {
      console.error("[auth] Erro ao adquirir token silencioso", err);
      if (!isMountedRef.current) return;

      const fallbackAccount = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
      if (fallbackAccount) {
        const normalized = normalizeUser(fallbackAccount, undefined, undefined);
        setUser(normalized);
        persistUser(normalized);
      } else {
        setUser(null);
        persistUser(null);
      }
      setError("Não foi possível conectar ao SSO. Tente novamente.");
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [environmentError]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!msalInstance || !isSsoEnvironmentReady) {
        if (!cancelled && isMountedRef.current) {
          setIsLoading(false);
          if (environmentError) {
            setError(environmentError);
          }
        }
        return;
      }

      try {
        console.log("[auth] Inicializando MSAL...");
        await withTimeout(msalInstance.initialize(), MSAL_TIMEOUT_MS, "MSAL initialize");
        console.log("[auth] MSAL inicializado com sucesso");
        
        console.log("[auth] Processando redirect promise...");
        const redirectResult = await withTimeout(msalInstance.handleRedirectPromise(), MSAL_TIMEOUT_MS, "MSAL handleRedirectPromise");
        console.log("[auth] Redirect result:", redirectResult);

        if (cancelled || !isMountedRef.current) {
          return;
        }

        if (redirectResult?.account) {
          console.log("[auth] Conta encontrada no redirect:", redirectResult.account.username);
          msalInstance.setActiveAccount(redirectResult.account);
        } else {
          console.log("[auth] Nenhuma conta no redirect, procurando contas existentes...");
          const existingAccount = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
          if (existingAccount) {
            console.log("[auth] Conta existente encontrada:", existingAccount.username);
            msalInstance.setActiveAccount(existingAccount);
          } else {
            console.log("[auth] Nenhuma conta encontrada");
          }
        }

        console.log("[auth] Carregando usuário...");
        await loadUser();
      } catch (err) {
        const details = getErrorDetails(err);
        console.error("[auth] Erro inicializando MSAL - Detalhes completos:", err);
        console.error("[auth] Tipo do erro:", typeof err);
        console.error("[auth] Nome do erro:", details.name);
        console.error("[auth] Mensagem do erro:", details.message);
        console.error("[auth] Stack:", details.stack);
        if (!cancelled && isMountedRef.current) {
          setIsLoading(false);
          setError(`Erro SSO: ${details.message}`);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [loadUser, environmentError]);

  const login = useCallback(async () => {
    if (!msalInstance || !isSsoEnvironmentReady) {
      setError(environmentError);
      return;
    }
    setError(null);
    await msalInstance.loginRedirect(loginRequest);
  }, [environmentError]);

  const logout = useCallback(async () => {
    // Limpa apenas a sessão local da dashboard, sem fazer logout da Microsoft
    console.log("[auth] Fazendo logout local (mantendo sessão Microsoft)");
    persistUser(null);
    setUser(null);
    
    // Limpa a conta ativa do MSAL localmente, mas não faz logout redirect
    if (msalInstance && isSsoEnvironmentReady) {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        // Remove a conta ativa, mas mantém o cache para login rápido
        msalInstance.setActiveAccount(null);
      }
    }
    
    // Redireciona para a página de login sem fazer logout da Microsoft
    window.location.href = "/login";
  }, []);

  const refreshUser = useCallback(async () => {
    setIsLoading(true);
    await loadUser();
  }, [loadUser]);

  const acquireToken = useCallback(async (additionalScopes?: string[]) => {
    if (!msalInstance || !isSsoEnvironmentReady) {
      return null;
    }
    const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
    if (!account) {
      return null;
    }

    try {
      const scopes = additionalScopes && additionalScopes.length > 0 ? additionalScopes : loginRequest.scopes;
      const result = await withTimeout(
        msalInstance.acquireTokenSilent({
          scopes,
          account,
        }),
        MSAL_TIMEOUT_MS,
        "acquireTokenSilent",
      );
      return result.accessToken;
    } catch (err) {
      console.error("[auth] Erro ao adquirir token", err);
      return null;
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user, 
    isLoading,
    error,
    login,
    logout,
    refreshUser,
    acquireToken,
  }), [user, isLoading, error, login, logout, refreshUser, acquireToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuthContext deve ser utilizado dentro de AuthProvider");
  }
  return ctx;
}

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

const STORAGE_KEY = "oneview-auth-user";

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

function normalizeUser(account: AccountInfo, profile?: any, photo?: string): AuthUser {
  const claims = account.idTokenClaims ?? {};
  const emailFromClaims = (claims.email as string) || (claims.preferred_username as string) || account.username;
  const profileMail = typeof profile?.mail === "string" ? profile.mail : undefined;
  const userPrincipal = typeof profile?.userPrincipalName === "string" ? profile.userPrincipalName : undefined;

  const email = emailFromClaims || profileMail || userPrincipal || "";
  const displayName =
    (typeof profile?.displayName === "string" && profile.displayName) ||
    (typeof claims.name === "string" && claims.name) ||
    account.name ||
    email ||
    "Usuário";

  return {
    id: (profile?.id as string) || account.localAccountId || null,
    name: displayName,
    email,
    firstName: typeof profile?.givenName === "string" ? profile.givenName : (claims.given_name as string | undefined),
    lastName: typeof profile?.surname === "string" ? profile.surname : (claims.family_name as string | undefined),
    username: userPrincipal || account.username,
    jobTitle: typeof profile?.jobTitle === "string" ? profile.jobTitle : undefined,
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
      const silentResult = await msalInstance.acquireTokenSilent({
        ...loginRequest,
        account,
      });

      const [profile, photo] = await Promise.all([
        fetchGraphProfile(silentResult.accessToken).catch((graphError) => {
          console.warn("[auth] Falha ao carregar perfil do Graph", graphError);
          return undefined;
        }),
        fetchGraphPhoto(silentResult.accessToken).catch(() => undefined),
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
  }, [environmentError, isSsoEnvironmentReady]);

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
        await msalInstance.initialize();
        console.log("[auth] MSAL inicializado com sucesso");
        
        console.log("[auth] Processando redirect promise...");
        const redirectResult = await msalInstance.handleRedirectPromise();
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
        console.error("[auth] Erro inicializando MSAL - Detalhes completos:", err);
        console.error("[auth] Tipo do erro:", typeof err);
        console.error("[auth] Nome do erro:", (err as any)?.name);
        console.error("[auth] Mensagem do erro:", (err as any)?.message);
        console.error("[auth] Stack:", (err as any)?.stack);
        if (!cancelled && isMountedRef.current) {
          setIsLoading(false);
          const errorMsg = (err as any)?.message || "Falha ao inicializar autenticação SSO";
          setError(`Erro SSO: ${errorMsg}`);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [loadUser, environmentError, isSsoEnvironmentReady]);

  const login = useCallback(async () => {
    if (!msalInstance || !isSsoEnvironmentReady) {
      setError(environmentError);
      return;
    }
    setError(null);
    await msalInstance.loginRedirect(loginRequest);
  }, [environmentError, isSsoEnvironmentReady]);

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
  }, [isSsoEnvironmentReady]);

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
      const result = await msalInstance.acquireTokenSilent({
        scopes,
        account,
      });
      return result.accessToken;
    } catch (err) {
      console.error("[auth] Erro ao adquirir token", err);
      return null;
    }
  }, [isSsoEnvironmentReady]);

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

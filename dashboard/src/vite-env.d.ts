/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
  readonly VITE_AZURE_CLIENT_ID?: string;
  readonly VITE_AZURE_TENANT_ID?: string;
  readonly VITE_AZURE_AUTHORITY?: string;
  readonly VITE_AZURE_REDIRECT_URI?: string;
  readonly VITE_AZURE_REDIRECT_URI_LOCAL?: string;
  readonly VITE_AZURE_POST_LOGOUT_URI?: string;
  readonly VITE_AZURE_POST_LOGOUT_URI_LOCAL?: string;
  readonly VITE_AZURE_SCOPES?: string;
  readonly VITE_MSAL_LOG_LEVEL?: string;
  readonly MICROSOFT_CLIENT_ID?: string;
  readonly MICROSOFT_TENANT_ID?: string;
  readonly MICROSOFT_AUTHORITY?: string;
  readonly MICROSOFT_REDIRECT_URI?: string;
  readonly MICROSOFT_POST_LOGOUT_URI?: string;
  readonly MICROSOFT_SCOPE?: string;
  readonly NEXT_PUBLIC_MICROSOFT_CLIENT_ID?: string;
  readonly NEXT_PUBLIC_MICROSOFT_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

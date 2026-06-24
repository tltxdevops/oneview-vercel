/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly NEXT_PUBLIC_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

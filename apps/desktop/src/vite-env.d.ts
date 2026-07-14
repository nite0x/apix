/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_FIXTURE_CATALOG?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

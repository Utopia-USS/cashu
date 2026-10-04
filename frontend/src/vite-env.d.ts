/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" routes every /api call to the in-memory demo backend (core/mock.ts). Dev only. */
  readonly VITE_MOCK?: string;
}

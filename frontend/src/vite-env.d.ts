/// <reference types="vite/client" />

// Injected at build time by vite.config.ts from package.json — the single
// source of truth for the app version (tauri.conf.json reads it too).
declare const __APP_VERSION__: string;
declare const __API_BASE__: string;
declare const __IS_TAURI__: boolean;

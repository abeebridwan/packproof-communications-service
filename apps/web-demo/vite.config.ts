import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  // The workspace keeps configuration at its root. Vite exposes only VITE_* to
  // the browser; provider and gateway secrets are never browser variables.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
})

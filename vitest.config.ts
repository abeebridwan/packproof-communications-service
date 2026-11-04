import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    pool: 'forks',
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      '@packproof/shared-contracts': new URL(
        './packages/shared-contracts/src/index.ts',
        import.meta.url,
      ).pathname,
      '@packproof/verification-adapters': new URL(
        './packages/verification-adapters/src/index.ts',
        import.meta.url,
      ).pathname,
      '@packproof/speech': new URL(
        './packages/speech/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
})

import { initializeLocalSecrets } from './environment.mjs'
initializeLocalSecrets(process.cwd())
console.log(
  'Local-only service secrets written to ignored .runtime/local.env. No live provider credentials added.',
)

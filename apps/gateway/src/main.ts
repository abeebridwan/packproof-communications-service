import dotenv from 'dotenv'
import { createGateway, configFromEnv } from './index.js'
dotenv.config({ path: '.env.local', quiet: true })
const { server } = createGateway(configFromEnv(process.env))
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () =>
  console.info(JSON.stringify({ service: 'gateway', event: 'ready' })),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close())

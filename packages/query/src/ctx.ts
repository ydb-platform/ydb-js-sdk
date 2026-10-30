import { AsyncLocalStorage } from 'node:async_hooks'
import type { Abortable } from 'node:events'

import type { QueryClient, QueryExecutor } from './client.js'

type Context = Abortable & { client: QueryClient; executor: QueryExecutor }

export let ctx = new AsyncLocalStorage<Context>()

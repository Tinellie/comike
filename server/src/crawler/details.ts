import { CheerioCrawler } from 'crawlee'
import type { Configuration } from 'crawlee'
import { isLoginPage, LoginRequiredError } from './parser.js'
import type { LoginSession } from './login.js'

export interface DetailOptions {
  requests: { id: string; url: string }[]
  login: Pick<LoginSession, 'generation' | 'cookieHeader'>
  config: Configuration
  signal: AbortSignal
  beforeRequest: () => Promise<void>
  loginRequired: (generation: number) => Promise<void>
  process: (id: string, html: string) => Promise<void>
  failed: (id: string, error: Error) => Promise<void>
}

export async function collectDetails(options: DetailOptions) {
  const { signal, login } = options
  const crawler = new CheerioCrawler({
    minConcurrency: 5,
    maxConcurrency: 5,
    maxRequestsPerMinute: 180,
    maxRequestRetries: 2,
    useSessionPool: false,
    requestHandlerTimeoutSecs: 3600,
    preNavigationHooks: [async ({ request }, requestOptions) => {
      signal.throwIfAborted()
      await options.beforeRequest()
      signal.throwIfAborted()
      request.userData.loginGeneration = login.generation
      requestOptions.headers = {
        ...requestOptions.headers,
        cookie: await login.cookieHeader(request.url),
      }
    }],
    async errorHandler({ response, request }, error) {
      if (signal.aborted) {
        request.noRetry = true
        return
      }
      console.warn('Detail request will be retried:', error.message)
      if (response?.statusCode && [401, 403].includes(response.statusCode)) {
        await options.loginRequired(request.userData.loginGeneration)
      }
    },
    async requestHandler({ request, body, response }) {
      signal.throwIfAborted()
      try {
        const html = String(body)
        if (isLoginPage(response.url ?? request.loadedUrl ?? request.url, html)) throw new LoginRequiredError()
        await options.process(request.userData.boothId, html)
      } catch (error) {
        if (error instanceof LoginRequiredError) await options.loginRequired(request.userData.loginGeneration)
        throw error
      }
    },
    async failedRequestHandler({ request }, error) {
      if (!signal.aborted) await options.failed(request.userData.boothId, error)
    },
  }, options.config)
  const abort = () => { void crawler.autoscaledPool?.abort().catch(error => console.error('Detail abort failed:', error)) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await crawler.run(options.requests.map(({ id, url }) => ({ url, userData: { boothId: id } })))
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

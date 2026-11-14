export async function remoteApi<T>(basePath: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T | undefined> {
  const response = await fetch(`${basePath}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(path.endsWith('status') ? 8000 : ['reset', 'organize'].includes(path) ? 120_000 : 45_000)]),
    cache: 'no-store',
  }).catch((reason: unknown) => {
    if (reason instanceof DOMException && reason.name === 'TimeoutError') {
      throw new Error('服务器响应超时，请检查后端是否正在运行或被调试器暂停，然后重试')
    }
    throw reason
  })
  if (!response.ok) {
    const result: unknown = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
    throw new Error(result && typeof result === 'object' && 'message' in result && typeof result.message === 'string'
      ? result.message : `操作失败（HTTP ${response.status}）`)
  }
  return response.status === 204 ? undefined : response.json()
}

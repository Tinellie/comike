export interface ColourPriority {
  colour: string
  priority: number
  coefficient: number
}

export async function saveColourCoefficient(colour: string, coefficient: number) {
  const response = await fetch('/api/colours/coefficient', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ colour, coefficient }),
    signal: AbortSignal.timeout(20_000),
    keepalive: true,
  })
  if (!response.ok) {
    const body: { message?: string } = await response.json()
    throw new Error(body.message ?? `颜色系数保存失败（HTTP ${response.status}）`)
  }
}

export async function requestColours(signal: AbortSignal, colours?: string[]): Promise<ColourPriority[]> {
  const response = await fetch('/api/colours', {
    method: colours ? 'PUT' : 'GET',
    headers: colours ? { 'Content-Type': 'application/json' } : undefined,
    body: colours ? JSON.stringify({ colours }) : undefined,
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  const body: { colours: ColourPriority[]; message?: string } = await response.json()
  if (!response.ok) throw new Error(body.message ?? `颜色配置请求失败（HTTP ${response.status}）`)
  return body.colours
}

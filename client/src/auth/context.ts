import { createContext, useContext } from 'react'

export interface AuthUser { id: string; username: string; isAdmin: boolean }

export interface AuthState {
  user: AuthUser | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('AuthProvider is missing')
  return context
}

export async function authRequest(path: string, body?: { username: string; password: string }): Promise<{ user: AuthUser | null }> {
  const response = await fetch(`/api/auth/${path}`, {
    method: path === 'me' ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const result: unknown = response.headers.get('content-type')?.includes('application/json')
      ? await response.json() : null
    throw new Error(result && typeof result === 'object' && 'message' in result && typeof result.message === 'string'
      ? result.message : `认证请求失败（HTTP ${response.status}），请检查服务端连接`)
  }
  return response.json()
}

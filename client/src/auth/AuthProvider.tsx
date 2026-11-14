import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AuthContext, authRequest } from './context'
import type { AuthUser } from './context'

async function loadSession() {
  try {
    const { user } = await authRequest('me')
    return { user, loading: false, error: null }
  } catch (error) {
    console.error('Session lookup failed:', error)
    return { user: null, loading: false, error: error instanceof Error ? error.message : '认证服务不可用' }
  }
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<{ user: AuthUser | null; loading: boolean; error: string | null }>({
    user: null, loading: true, error: null,
  })
  const refresh = useCallback(() => loadSession().then(setSession), [])
  useEffect(() => {
    let active = true
    void loadSession().then(result => { if (active) setSession(result) })
    return () => { active = false }
  }, [])

  async function login(username: string, password: string) {
    const { user } = await authRequest('login', { username, password })
    setSession({ user, loading: false, error: null })
  }
  async function register(username: string, password: string) {
    await authRequest('register', { username, password })
  }
  async function logout() {
    await authRequest('logout')
    setSession({ user: null, loading: false, error: null })
  }
  return <AuthContext.Provider value={{ ...session, refresh, login, register, logout }}>{children}</AuthContext.Provider>
}

import { useState, useEffect, useCallback } from 'react'

export interface AuthUser {
  id: string
  username: string
  avatarUrl: string | null
  messageCount: number
  limit: number
  unlimited: boolean
  /** null when unlimited */
  remaining: number | null
}

export interface UseAuthReturn {
  user: AuthUser | null
  loading: boolean
  login: () => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/auth/me')
      setUser(res.ok ? ((await res.json()) as AuthUser) : null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Re-fetch the remaining quota after each send (useChat dispatches this).
  useEffect(() => {
    const handler = (): void => { void refresh() }
    window.addEventListener('auth:refresh', handler)
    return () => window.removeEventListener('auth:refresh', handler)
  }, [refresh])

  const login = useCallback((): void => {
    window.location.href = '/api/auth/github'
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      setUser(null)
    }
  }, [])

  return { user, loading, login, logout, refresh }
}

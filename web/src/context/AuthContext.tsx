import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type WebRole } from '../api/client'

interface AuthState {
  role: WebRole | null
  loading: boolean
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<WebRole | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then((r) => setRole(r.role))
      .catch(() => setRole(null))
      .finally(() => setLoading(false))
  }, [])

  const login = async (password: string): Promise<void> => {
    const r = await api.login(password)
    setRole(r.role)
  }

  const logout = async (): Promise<void> => {
    await api.logout()
    setRole(null)
  }

  return <AuthContext.Provider value={{ role, loading, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

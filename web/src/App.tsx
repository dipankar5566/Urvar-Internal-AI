import { useEffect, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ToastProvider } from './context/ToastContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './pages/LoginPage'
import { ChatPage } from './pages/ChatPage'
import { LeadsPage } from './pages/LeadsPage'
import { KbPage } from './pages/KbPage'
import { ReportsPage } from './pages/ReportsPage'
import { GuidePage } from './pages/GuidePage'
import { api } from './api/client'
import { formatUptime } from './lib/format'

type Tab = 'chat' | 'leads' | 'kb' | 'reports' | 'guide'

const NAV_ICONS: Record<Tab, string> = {
  chat: '◉',
  leads: '▤',
  reports: '▦',
  kb: '◈',
  guide: '?',
}

const WELCOME_SEEN_KEY = 'urvar_seen_welcome'

function Dashboard() {
  const { role, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('chat')
  const [health, setHealth] = useState<{ uptimeMs: number; version: string } | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(WELCOME_SEEN_KEY))

  useEffect(() => {
    api.health().then(setHealth).catch(() => {})
  }, [])

  const dismissWelcome = (): void => {
    localStorage.setItem(WELCOME_SEEN_KEY, '1')
    setShowWelcome(false)
  }

  const openGuide = (): void => {
    dismissWelcome()
    setTab('guide')
  }

  const tryPrompt = (prompt: string): void => {
    setPendingPrompt(prompt)
    setTab('chat')
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'leads', label: 'Leads' },
    { id: 'reports', label: 'Reports' },
    ...(role === 'owner' ? [{ id: 'kb' as Tab, label: 'Knowledge base' }] : []),
    { id: 'guide', label: 'Guide' },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/urvar-mark.png" alt="Urvar" className="sidebar-mark" />
          <span className="wordmark">Urvar</span>
        </div>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === tab ? 'sidebar-link active' : 'sidebar-link'}
              onClick={() => setTab(t.id)}
            >
              <span className="icon" aria-hidden="true">
                {NAV_ICONS[t.id]}
              </span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="role-row">
            <span>Signed in as {role}</span>
          </div>
          <button type="button" className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
          {health && (
            <div className="tiny mono">
              v{health.version} · up {formatUptime(health.uptimeMs)}
            </div>
          )}
        </div>
      </aside>
      <div className="app-main">
        {showWelcome && (
          <div className="welcome-banner">
            <span>
              New here? The <strong>Guide</strong> explains what this dashboard does and how to use it.
            </span>
            <div className="welcome-actions">
              <button type="button" onClick={openGuide}>
                Open the Guide
              </button>
              <button type="button" className="ghost" onClick={dismissWelcome}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {tab === 'chat' ? (
          <ChatPage initialPrompt={pendingPrompt} onPromptConsumed={() => setPendingPrompt(null)} />
        ) : (
          <main className="page-container">
            {tab === 'leads' && <LeadsPage />}
            {tab === 'reports' && <ReportsPage />}
            {tab === 'kb' && role === 'owner' && <KbPage />}
            {tab === 'guide' && <GuidePage onTryPrompt={tryPrompt} />}
          </main>
        )}
      </div>
    </div>
  )
}

function Gate() {
  const { role, loading } = useAuth()
  if (loading) return <div className="login-screen">Loading…</div>
  return role ? <Dashboard /> : <LoginPage />
}

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  )
}

export default App

import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { LoginGate } from './components/LoginGate'
import { ChatView } from './components/ChatView'
import { TracesPage } from './components/TracesPage'
import { TraceDetailPage } from './components/TraceDetailPage'
import styles from './App.module.css'

export default function App() {
  const auth = useAuth()

  if (auth.loading) {
    return <div className={styles.authLoading}>加载中…</div>
  }
  if (!auth.user) {
    return <LoginGate onLogin={auth.login} />
  }

  const { user } = auth
  return (
    <Routes>
      <Route path="/" element={<ChatView user={user} onLogout={() => void auth.logout()} />} />
      <Route
        path="/traces"
        element={user.isAdmin ? <TracesPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/traces/:id"
        element={user.isAdmin ? <TraceDetailPage /> : <Navigate to="/" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

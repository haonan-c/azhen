import { ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { useAuth, CF_ACCESS_MODE } from './useAuth'
import { AuthProvider } from './AuthContext'
import LoginPage from './LoginPage'
import { Loader, Banner, Button } from '@cloudflare/kumo'
import LanguageSelector from './components/LanguageSelector'
import { m as messages } from './paraglide/messages.js'

interface ProtectedRouteProps {
  children: ReactNode
  rpcStub: RpcStub<PublicApi>
}

export default function ProtectedRoute({ children, rpcStub }: ProtectedRouteProps) {
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } = useAuth(rpcStub)

  const handleLoginSuccess = () => {
    // Trigger re-authentication by calling login with stored token
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
          position: 'relative',
        }}
      >
        <LanguageSelector className="absolute right-4 top-4" />
        <Loader size="lg" />
        <div style={{ textAlign: 'center' }}>
          {messages.auth_session_checking()}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
          position: 'relative',
        }}
      >
        <LanguageSelector className="absolute right-4 top-4" />
        <Banner
          variant="error"
          title={messages.auth_session_retry()}
          description={error}
          className="mb-4"
        />
        <Button variant="primary" onClick={() => window.location.reload()}>
          {messages.auth_retry()}
        </Button>
      </div>
    )
  }

  // In CF Access mode the user is always authenticated (Access enforces login before the
  // app loads), so we never show the login page. If not authenticated yet, keep the
  // spinner up while the pipelined authenticateFromCfAccess() call resolves.
  if (!isAuthenticated) {
    if (CF_ACCESS_MODE) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 16,
            position: 'relative',
          }}
        >
          <LanguageSelector className="absolute right-4 top-4" />
          <Loader size="lg" />
          <div style={{ textAlign: 'center' }}>
            {messages.auth_session_checking()}
          </div>
        </div>
      )
    }
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  return (
    <AuthProvider authenticatedApi={authenticatedApi!} onLogout={logout}>
      {children}
    </AuthProvider>
  )
}

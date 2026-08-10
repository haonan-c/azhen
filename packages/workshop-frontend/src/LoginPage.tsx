import { useState, FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { Hexagon } from '@phosphor-icons/react'
import { Input, Button, Banner } from '@cloudflare/kumo'
import { hashPassword } from './passwordHash'
import { useServerConfig, useServerConfigError, useSiteName } from './ServerConfigContext'
import { useDocumentTitle } from './useDocumentTitle'
import { useConnectionLost } from './RpcContext'
import OAuthButtons from './components/auth/OAuthButtons'
import SiteLogo from './components/SiteLogo'
import LanguageSelector from './components/LanguageSelector'
import AuthConfigStatus from './components/auth/AuthConfigStatus'
import { m as messages } from './paraglide/messages.js'


interface LoginPageProps {
  rpcStub: RpcStub<PublicApi>
  onLoginSuccess?: () => void
}

export default function LoginPage({ rpcStub, onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const serverConfig = useServerConfig()
  const serverConfigError = useServerConfigError()
  const siteName = useSiteName()
  const connectionLost = useConnectionLost()
  useDocumentTitle(messages.auth_sign_in_document_title())

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username || !password || loading) return
    setLoading(true)
    setError(null)

    try {
      const passwordHash = await hashPassword(username, password)
      const token = await rpcStub.login(username, passwordHash)
      if (token) {
        localStorage.setItem('authToken', token)
        if (onLoginSuccess) {
          onLoginSuccess()
        } else {
          window.location.reload()
        }
      } else {
        setError({ title: messages.auth_invalid_credentials() })
      }
    } catch (err) {
      setError({
        title: messages.auth_sign_in_error_title(),
        detail: err instanceof Error ? err.message : messages.auth_unknown_error_detail(),
      })
    } finally {
      setLoading(false)
    }
  }

  // Until the deployment config loads we don't know which auth methods are enabled, so don't guess:
  // defaulting to the password form would show it even where it's disabled (and hide configured
  // OAuth providers). This is especially important when the server is unreachable — serverConfig
  // stays null — so render a loading / connection state instead of a misconfigured form.
  if (!serverConfig) {
    return <AuthConfigStatus connectionLost={connectionLost} hasError={serverConfigError} />
  }

  const authVendors = serverConfig.authVendors ?? []
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled

  return (
    <div className="min-h-screen flex items-center justify-center bg-kumo-base px-4 relative overflow-hidden">
      <LanguageSelector className="absolute right-4 top-4 z-10" />
      {/* Dot grid — fades from top to bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)',
        }}
      />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <SiteLogo size={40} className="mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-kumo-brand mb-3">
              <Hexagon size={20} className="text-white" weight="bold" />
            </div>
          </SiteLogo>
          <h1 className="text-xl font-semibold text-kumo-default">{siteName}</h1>
          <p className="text-sm text-kumo-subtle mt-1">{messages.auth_sign_in_heading()}</p>
        </div>

        {passwordAuthEnabled && (
          <>
            {/* Username / password form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label={messages.auth_username_label()}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                disabled={loading}
                placeholder={messages.auth_username_placeholder()}
              />

              <Input
                type="password"
                label={messages.auth_password_label()}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading}
                placeholder={messages.auth_password_placeholder()}
              />

              {error && (
                <Banner variant="error" title={error.title} description={error.detail} />
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={!username || !password}
                loading={loading}
                className="w-full justify-center"
              >
                {messages.auth_sign_in_submit()}
              </Button>
            </form>

            <p className="text-center text-sm text-kumo-subtle mt-6">
              {messages.auth_no_account()}{' '}
              <Link to="/signup" className="text-kumo-brand hover:underline font-medium">
                {messages.auth_create_account()}
              </Link>
            </p>
          </>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? 'mt-6' : ''}>
            {passwordAuthEnabled && (
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-kumo-line" />
                <span className="text-xs text-kumo-subtle">{messages.auth_or()}</span>
                <div className="h-px flex-1 bg-kumo-line" />
              </div>
            )}
            {!passwordAuthEnabled && error && (
              <Banner
                variant="error"
                title={error.title}
                description={error.detail}
                className="mb-4"
              />
            )}
            <OAuthButtons rpcStub={rpcStub} vendors={authVendors} onSuccess={onLoginSuccess} />
          </div>
        )}
      </div>
    </div>
  )
}

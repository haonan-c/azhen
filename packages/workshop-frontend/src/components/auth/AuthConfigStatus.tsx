import { Button, Loader } from '@cloudflare/kumo'
import { m as messages } from '../../paraglide/messages.js'
import LanguageSelector from '../LanguageSelector'

interface AuthConfigStatusProps {
  connectionLost: boolean
  hasError: boolean
}

export default function AuthConfigStatus({ connectionLost, hasError }: AuthConfigStatusProps) {
  if (hasError && !connectionLost) {
    return (
      <div
        role="alert"
        className="relative min-h-screen flex flex-col items-center justify-center gap-4 bg-kumo-base px-4"
      >
        <LanguageSelector className="absolute right-4 top-4" />
        <p className="text-sm text-kumo-danger text-center">
          {messages.auth_deployment_settings_error()}
        </p>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {messages.auth_reload()}
        </Button>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center gap-4 bg-kumo-base px-4">
      <LanguageSelector className="absolute right-4 top-4" />
      <Loader size="lg" aria-label={messages.auth_loading()} />
      <p className="text-sm text-kumo-subtle text-center">
        {connectionLost ? messages.auth_server_retrying() : messages.auth_loading()}
      </p>
    </div>
  )
}

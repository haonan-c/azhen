import { Component, type ReactNode } from 'react'
import { reportIssue } from './errorReporting'
import { m as messages } from './paraglide/messages.js'

type Props = { children: ReactNode }
type State = { crashed: boolean; diagnostic?: string }

/** Last-resort Workshop shell fallback for unexpected React render crashes. */
export default class FrontendErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  static getDerivedStateFromError(error: Error): State {
    return { crashed: true, diagnostic: error.message }
  }

  componentDidCatch(error: Error) {
    reportIssue('workshop.react-render', error, {
      handled: false,
      severity: 'fatal',
      captureMechanism: 'react',
    })
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">{messages.error_boundary_title()}</h1>
        <p className="text-sm text-kumo-subtle">{messages.error_boundary_description()}</p>
        {this.state.diagnostic && (
          <p className="text-sm text-kumo-subtle">
            {messages.error_boundary_diagnostic({ detail: this.state.diagnostic })}
          </p>
        )}
        <button className="rounded-md bg-kumo-brand px-4 py-2 text-sm" onClick={() => location.reload()}>
          {messages.error_boundary_reload()}
        </button>
      </main>
    )
  }
}

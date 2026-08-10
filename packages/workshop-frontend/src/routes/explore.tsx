import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { m as messages } from '../paraglide/messages.js'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  useDocumentTitle(messages.shell_explore())

  return <BlueprintsPage />
}

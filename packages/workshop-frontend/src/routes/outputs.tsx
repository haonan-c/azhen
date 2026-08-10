import { createFileRoute } from '@tanstack/react-router'
import OutputsPage from './-OutputsPage'

export const Route = createFileRoute('/outputs')({
  component: OutputsPage,
})

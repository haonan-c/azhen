import { Switch, Tooltip } from '@cloudflare/kumo'
import { m as messages } from '../paraglide/messages.js'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

/** Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat. */
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  return (
    <Tooltip content={enabled ? messages.hook_disable_description() : messages.hook_enable_description()} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? messages.hook_disable() : messages.hook_enable()}
        />
      </span>
    </Tooltip>
  )
}

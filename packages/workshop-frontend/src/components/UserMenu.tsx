import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'
import { changeLocale } from '../locale'
import { getLocale, type Locale } from '../paraglide/runtime.js'
import { m as messages } from '../paraglide/messages.js'

export default function UserMenu() {
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className="w-7 h-7 cursor-pointer rounded-full flex items-center justify-center bg-kumo-tint hover:bg-kumo-fill transition-colors overflow-hidden"
            title={messages.user_menu_open()}
            aria-label={messages.user_menu_open()}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          {messages.user_menu_profile()}
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            {messages.user_menu_admin()}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>{messages.user_menu_language()}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={getLocale()}
            onValueChange={locale => changeLocale(locale as Locale)}
          >
            <DropdownMenu.RadioItem value="en" className={MENU_ITEM}>
              {messages.language_english()}
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="zh" className={MENU_ITEM}>
              {messages.language_chinese()}
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          {messages.user_menu_sign_out()}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

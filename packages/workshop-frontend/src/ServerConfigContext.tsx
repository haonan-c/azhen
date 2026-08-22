import { createContext, useContext } from 'react'
import type { ServerConfig, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { m as messages } from './paraglide/messages.js'

/**
 * Deployment-level configuration fetched once at boot via PublicApi.getServerConfig().
 * `null` while still loading.
 */
export const ServerConfigContext = createContext<ServerConfig | null>(null)
export const ServerConfigErrorContext = createContext(false)

/** Returns the server config, or null while it is still loading. */
export function useServerConfig(): ServerConfig | null {
  return useContext(ServerConfigContext)
}

/** Returns whether the latest deployment-config request failed. */
export function useServerConfigError(): boolean {
  return useContext(ServerConfigErrorContext)
}

/**
 * Convenience: the admin-configured site name, falling back to the default while config is still
 * loading or when the admin hasn't set one.
 */
export function useSiteName(): string {
  return useContext(ServerConfigContext)?.siteName.trim() || messages.brand_name()
}

/** Convenience: the gatekeeper vendors offered as sign-in methods (empty until config loads / none). */
export function useAuthVendors(): AuthVendorInfo[] {
  return useContext(ServerConfigContext)?.authVendors ?? []
}

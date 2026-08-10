import { useState, useEffect, useRef, useCallback } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

const SIGNED_OUT_STATE: AuthState = {
  token: null,
  authenticatedApi: null,
  isLoading: false,
  error: null,
}

export { CF_ACCESS_MODE }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isInvalidSession(error: unknown): boolean {
  return /^invalid session token\.?$/i.test(errorMessage(error))
}

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null
  })

  const requestIdRef = useRef(0)
  const validatingApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)

  const disposeApis = useCallback(() => {
    validatingApiRef.current?.[Symbol.dispose]()
    authenticatedApiRef.current?.[Symbol.dispose]()
    validatingApiRef.current = null
    authenticatedApiRef.current = null
  }, [])

  const resetToSignedOut = useCallback(() => {
    requestIdRef.current++
    disposeApis()
    setAuthState(SIGNED_OUT_STATE)
  }, [disposeApis])

  const validate = useCallback((
    token: string | null,
    authenticate: () => RpcStub<AuthenticatedApi>,
  ) => {
    const requestId = ++requestIdRef.current
    disposeApis()
    setAuthState({ token, authenticatedApi: null, isLoading: true, error: null })

    let authenticatedApi: RpcStub<AuthenticatedApi> | null = null
    const fail = (error: unknown) => {
      if (validatingApiRef.current === authenticatedApi) {
        validatingApiRef.current = null
        authenticatedApi?.[Symbol.dispose]()
      }
      if (requestId !== requestIdRef.current) return

      if (token !== null && isInvalidSession(error)) {
        if (localStorage.getItem('authToken') === token) localStorage.removeItem('authToken')
        setAuthState(SIGNED_OUT_STATE)
      } else {
        setAuthState({
          token,
          authenticatedApi: null,
          isLoading: false,
          error: errorMessage(error),
        })
      }
    }

    try {
      // Keep promise pipelining: start the identity check without waiting for authenticate() to
      // resolve, but do not expose the capability until the check succeeds.
      authenticatedApi = authenticate()
      validatingApiRef.current = authenticatedApi
      authenticatedApi.whoami().then(() => {
        if (requestId !== requestIdRef.current) {
          if (validatingApiRef.current === authenticatedApi) {
            validatingApiRef.current = null
            authenticatedApi?.[Symbol.dispose]()
          }
          return
        }
        validatingApiRef.current = null
        authenticatedApiRef.current = authenticatedApi
        setAuthState({ token, authenticatedApi, isLoading: false, error: null })
      }).catch(fail)
    } catch (error) {
      fail(error)
    }
  }, [disposeApis])

  const authenticateWithCfAccess = useCallback(() => {
    validate(null, () => publicApi.authenticateFromCfAccess())
  }, [publicApi, validate])

  const authenticateWithToken = useCallback((token: string) => {
    validate(token, () => publicApi.authenticate(token))
  }, [publicApi, validate])

  useEffect(() => {
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        authenticateWithToken(storedToken)
      } else {
        setAuthState(SIGNED_OUT_STATE)
      }
    }
    return () => {
      requestIdRef.current++
      disposeApis()
    }
  }, [authenticateWithCfAccess, authenticateWithToken, disposeApis])

  const login = useCallback((token: string) => {
    authenticateWithToken(token)
  }, [authenticateWithToken])

  const logout = useCallback(() => {
    if (CF_ACCESS_MODE) {
      resetToSignedOut()
      window.location.assign('/cdn-cgi/access/logout')
      return
    }

    resetToSignedOut()
    localStorage.removeItem('authToken')
  }, [resetToSignedOut])

  const retry = useCallback(() => {
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
      return
    }

    const storedToken = localStorage.getItem('authToken')
    if (storedToken) {
      authenticateWithToken(storedToken)
    } else {
      resetToSignedOut()
    }
  }, [authenticateWithCfAccess, authenticateWithToken, resetToSignedOut])

  return {
    ...authState,
    login,
    logout,
    retry,
    isAuthenticated: !!authState.authenticatedApi
  }
}

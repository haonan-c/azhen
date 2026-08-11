import { useEffect, useState } from 'react'

export function useSessionStorageSearch(storageKey: string) {
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.sessionStorage.getItem(storageKey) ?? ''
  })

  useEffect(() => {
    window.sessionStorage.setItem(storageKey, search)
  }, [search, storageKey])

  return [search, setSearch] as const
}

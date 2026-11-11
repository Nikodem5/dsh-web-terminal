// dsh-web-terminal — renders the brief notices of notice.ts at the bottom of the Terminals page.

import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { getNotices, subscribeNotices } from './notice.ts'

export function Notices(): ReactElement | null {
  const notices = useSyncExternalStore(subscribeNotices, getNotices, getNotices)
  if (notices.length === 0) return null
  return (
    <div className="wt-notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="wt-notice">{n.text}</div>
      ))}
    </div>
  )
}

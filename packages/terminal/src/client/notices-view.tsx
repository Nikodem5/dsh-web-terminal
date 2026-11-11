// dsh-web-terminal — renders the page notices (notices.ts) at the bottom of the Terminals page.

import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { dismissNotice, getNotices, subscribeNotices } from './notices.ts'

export function Notices(): ReactElement | null {
  const notices = useSyncExternalStore(subscribeNotices, getNotices, getNotices)
  if (notices.length === 0) return null
  return (
    <div className="wt-notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="wt-notice" title={n.title}>
          <span>{n.text}</span>
          <button type="button" className="wt-hbtn" title="Dismiss" aria-label="Dismiss" onClick={() => dismissNotice(n.id)}>✕</button>
        </div>
      ))}
    </div>
  )
}

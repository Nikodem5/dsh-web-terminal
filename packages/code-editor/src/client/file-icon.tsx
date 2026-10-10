// dsh-code-editor - the explorer / tab / quick-open / changes icons: tiny inline SVGs, no icon font.

import type { ReactElement } from 'react'
import { fileIconFor } from './file-icons.ts'
import { baseName } from './paths.ts'

/** A coloured badge with a short label for known types, a plain outline otherwise. `name` may be a path. */
export function FileIcon({ name }: { name: string }): ReactElement {
  const icon = fileIconFor(baseName(name))
  if (icon.label === '') {
    return (
      <svg className="ce-ficon" data-icon={icon.id} viewBox="0 0 16 16" fill="none" stroke="var(--ce-dim)" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 1.8h5l3 3V14.2H4z" /><path d="M9 1.8v3h3" />
      </svg>
    )
  }
  const size = icon.label.length >= 3 ? 5.6 : icon.label.length === 2 ? 7 : 9
  return (
    <svg className="ce-ficon" data-icon={icon.id} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="2.5" fill={icon.bg} />
      <text x="8" y="11.2" textAnchor="middle" fontSize={size} fontWeight="700" fontFamily="system-ui, sans-serif" fill={icon.fg}>{icon.label}</text>
    </svg>
  )
}

/** Folder, open or closed (follows the text colour). */
export function FolderIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg className="ce-ficon ce-folder" data-icon={open ? 'folder-open' : 'folder'} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      {open ? <><path d="M1.8 13V3.4h4l1.3 1.5h5.6V7" /><path d="M1.8 13l2-5.4h11.4L13 13z" /></> : <path d="M1.8 3.6h4l1.4 1.6h7V13H1.8z" />}
    </svg>
  )
}

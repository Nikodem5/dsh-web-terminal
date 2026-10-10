// dsh-code-editor - the one store behind the Code page (the page component unmounts when another panel is
// selected; open tabs and unsaved buffers must survive that).

import { browseFolder, canBrowse } from '../../../shared/client/directory-picker.ts'
import { createApi } from './api.ts'
import { EditorStore } from './store.ts'
import { isDarkSurface } from './theme.ts'

let store: EditorStore | null = null
let selectPanel: (() => void) | undefined

/** Set by the plugin entry: switch the harness to the Code page. */
export function setSelectPanel(fn: (() => void) | undefined): void { selectPanel = fn }

export function getStore(): EditorStore {
  if (store === null) {
    store = new EditorStore({
      api: createApi(),
      confirm: (m) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(m) : true),
      isDark: isDarkSurface,
      picker: { available: canBrowse, pick: browseFolder },
      loadAdapter: () => import('./monaco-adapter.ts').then((m) => m.factory),
      selectPanel: () => selectPanel?.(),
    })
  }
  return store
}

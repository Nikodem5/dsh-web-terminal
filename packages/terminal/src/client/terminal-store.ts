// dsh-web-terminal — client store barrel.
//
// The client state is split by job; this file re-exports the whole public surface so
// views import from one place.
//
//   state.ts        window store, preferences, live runtimes, persistence
//   names.ts        folder labels and program-derived window names
//   windows.ts      open / close / focus / maximize / presets
//   runtime.ts      xterm + WebSocket behind each window
//   start.ts        reattach saved terminals at plugin start
//   attention.ts    activity and "needs you" detection, notifications
//   veil.ts         placeholder over an agent terminal until the agent is up
//   search.ts       find-in-terminal
//   layouts.ts      saved layouts
//   broadcast.ts    send to several terminals
//   launch.ts       what a conversation id may look like
//   providers.ts    agent providers: how each is recognised, launched and shown
//   preferences.ts  folders, favourites, on/off switches
//   appearance.ts   font and colour preferences
//   theme.ts        xterm palette and surface measurement
//   unread.ts       "new since you last looked" divider and jump
//   shortcuts.ts    keyboard shortcut registry (handlers and the help panel read it)
//   ssh.ts          SSH targets: validation, labels and socket parameters
//   placement.ts    where a new window goes (largest free gap, cascade)
//   term-prefs.ts, term-options.ts, copy-select.ts, zoom.ts, tags.ts, tag-palette.ts
//                   scrollback / cursor / copy-on-select, Ctrl+wheel font zoom, colour tags

export * from './types.ts'
export * from './state.ts'
export * from './names.ts'
export * from './windows.ts'
export * from './runtime.ts'
export * from './start.ts'
export * from './attention.ts'
export * from './pattern-alerts.ts'
export * from './pattern-alerts-core.ts'
export * from './git-header.ts'
export * from './veil.ts'
export * from './search.ts'
export * from './layouts.ts'
export * from './broadcast.ts'
export * from './launch.ts'
export * from './providers.ts'
export * from './prompt-ready.ts'
export * from './preferences.ts'
export * from './subagents.ts'
export * from './subagent-state.ts'
export * from './edits-api.ts'
export * from './workspaces.ts'
export * from './appearance.ts'
export * from './path-links.ts'
export * from './code-editor.ts'
export * from './send-to.ts'
export * from './notices.ts'
export * from './integrations.ts'
export * from './unread.ts'
export * from './theme.ts'
export * from './blocks.ts'
export * from './block-text.ts'
export * from './block-actions.ts'
export * from './block-bar.ts'
export * from './block-notify.ts'
export * from './mission.ts'
export * from './shortcuts.ts'
export * from './ssh.ts'
export * from './placement.ts'
export * from './term-prefs.ts'
export * from './term-options.ts'
export * from './copy-select.ts'
export * from './zoom.ts'
export * from './tags.ts'
export * from './tag-palette.ts'

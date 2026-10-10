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
//   search.ts       find-in-terminal
//   layouts.ts      saved layouts
//   broadcast.ts    send to several terminals
//   launch.ts       startup command rewriting (agent hooks)
//   preferences.ts  folders, favourites, on/off switches
//   appearance.ts   font and colour preferences
//   theme.ts        xterm palette and surface measurement
//   unread.ts       "new since you last looked" divider and jump
//   shortcuts.ts    keyboard shortcut registry (handlers and the help panel read it)
//   ssh.ts          SSH targets: validation, labels and socket parameters

export * from './types.ts'
export * from './state.ts'
export * from './names.ts'
export * from './windows.ts'
export * from './runtime.ts'
export * from './start.ts'
export * from './attention.ts'
export * from './search.ts'
export * from './layouts.ts'
export * from './broadcast.ts'
export * from './launch.ts'
export * from './prompt-ready.ts'
export * from './preferences.ts'
export * from './subagents.ts'
export * from './subagent-state.ts'
export * from './workspaces.ts'
export * from './appearance.ts'
export * from './path-links.ts'
export * from './send-to.ts'
export * from './unread.ts'
export * from './theme.ts'
export * from './blocks.ts'
export * from './mission.ts'
export * from './shortcuts.ts'
export * from './ssh.ts'

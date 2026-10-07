// dsh-web-terminal — client store barrel.
//
// The client state is split by job; this file re-exports the whole public surface so
// views import from one place.
//
//   state.ts        window store, preferences, live runtimes, persistence
//   names.ts        folder labels and program-derived window names
//   windows.ts      open / close / focus / maximize / presets
//   runtime.ts      xterm + WebSocket behind each window
//   attention.ts    activity and "needs you" detection, notifications
//   search.ts       find-in-terminal
//   layouts.ts      saved layouts
//   broadcast.ts    send to several terminals
//   launch.ts       startup command rewriting (agent hooks)
//   preferences.ts  folders, favourites, on/off switches
//   appearance.ts   font and colour preferences
//   theme.ts        xterm palette and surface measurement

export * from './types.ts'
export * from './state.ts'
export * from './names.ts'
export * from './windows.ts'
export * from './runtime.ts'
export * from './attention.ts'
export * from './search.ts'
export * from './layouts.ts'
export * from './broadcast.ts'
export * from './launch.ts'
export * from './preferences.ts'
export * from './appearance.ts'
export * from './theme.ts'

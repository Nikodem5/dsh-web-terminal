# Security

## Threat model

This project assumes a single-user machine. The harness web server has no authentication of its own, and both plugins expose routes that run programs or read and write files, so each plugin gates every HTTP route and WebSocket upgrade itself. A request is accepted only when all of these hold:

1. The TCP peer is loopback (`req.socket.remoteAddress`).
2. The `Host` header names a loopback host (`127.0.0.1`, `localhost`, `[::1]`). A tunnel or reverse proxy on this machine connects from loopback but arrives under its public name, and a DNS-rebinding page arrives under the attacker's name; both are refused.
3. The `Origin` header, when present, is a recognised page (the `Origin` check alone is not a boundary: non-browser clients send none).
4. It carries the per-boot bearer token. The host generates the token at start and puts it into the served page (`globalThis.__DSH_WT_TOKEN__`, through the harness's index-inject table); the client sends it as `Authorization: Bearer` and, on a WebSocket, as the `dsh-wt.<token>` subprotocol. It changes on every start, so reload the page after the harness restarts.

So `dsh web --host 0.0.0.0` does not expose a shell, and neither does a tunnel or proxy: the terminal and code editor stop working for a remote browser. There is no switch to relax this. `DSH_WT_ALLOWED_ORIGINS` still extends the allowed web origins but never lifts the loopback and Host rules.

Limits: the token is readable by anything that can load the page from a loopback Host, so any other local process or local user can still obtain it. Do not run this on a machine shared with users you do not trust. The agent-signal listener is separate (loopback-bound, per-terminal secret).

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please do not file public issues for security problems.

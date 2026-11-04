# Security

## Threat model

This project assumes a single-user machine. WebSocket upgrades are not authenticated by the harness. The terminal plugin refuses upgrades whose `Origin` header is foreign, which blocks web pages, but a local non-browser client that sends no `Origin` header is accepted and gets a shell. The owner accepts this as a known limit.

Do not run this on a machine shared with users you do not trust.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please do not file public issues for security problems.

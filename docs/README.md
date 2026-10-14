# Documentation

Reference pages for AI Whiteboard. The [main README](../README.md) is the short overview; these pages hold the detail.

- [Architecture](architecture.md): how the server, the web client and the desktop app fit together, how the app reaches every server, the MCP listener and board tools, subagent settings, `get_image`, images in a message, and pi.
- [Prompt library](prompt-library.md): the prompt library's popups, search, rules, storage, use with several servers, and its routes.
- [Remote servers](remote-servers.md): this computer and other servers as sections of the sidebar, building the server for another machine, setting it up, and using it from the app: chats, whiteboards, feature levels, the client API, and updating from the version before.
- [Server commands and flags](server-reference.md): the `ai-whiteboard` commands (start, stop, status, secret, set-up) and the server flags.
- [Troubleshooting the board MCP](troubleshooting.md): checking the listener, probing the endpoint, the server log, Cursor showing no board tools, port 6006 being taken, and this computer's server not starting.
- [Limitations](limitations.md): what the app does not do, and the caps on running chats.
- [Build and develop](development.md): prerequisites, running the desktop app in development, building the macOS app, the page in a headless browser, and the tests.

# DropDrop for VS Code

**Drop it. Share it. Sync it.**

Create or join a shared text/code room in VS Code. Anyone who opens the same room name, in VS Code or on the
DropDrop website, edits the same document in real time. No account, no login.

## Features

- **Create Room** / **Join Room**: pick a name (or get a random one) and start editing.
- **Real-time collaboration** with other VS Code windows and the DropDrop website (Yjs CRDT: simultaneous edits merge,
  nothing is overwritten).
- Syntax highlighting, line numbers, language selector, copy, select all, **Clear (with confirmation)**,
  undo / redo (Ctrl+Z / Ctrl+Y; they only undo *your* edits).
- Honest status: **Connecting / Connected / Disconnected / Reconnecting**, a **✓ Saved** indicator confirmed by the
  server, and a participant count that only shows real, currently connected people.
- Automatic reconnection. Edits made while offline are kept and merged when the connection returns.
- **Copy Room Link** gives the website URL for the room.

## Commands (Command Palette, `Ctrl+Shift+P`)

| Command | What it does |
| --- | --- |
| `DropDrop: Open DropDrop` | Open the editor for the current room (or choose Create/Join) |
| `DropDrop: Join Room` | Enter a room name; creates the room if it is new |
| `DropDrop: Create Room` | Generates a random, unused room name and joins it |
| `DropDrop: Leave Room` | Disconnects; the document stays saved on the server |
| `DropDrop: Copy Room Link` | Copies `https://<your website>/<room>` |

The **DropDrop** activity-bar icon shows the current room, status, participants and the same actions.

## ⚠️ Privacy: rooms are not password protected

**Anyone who knows (or guesses) a room name can read and edit its document.** Use an unguessable name for anything
private, and do not put secrets (passwords, API keys, personal data) in a room. Documents are stored on the DropDrop
server's database until they are cleared. The extension never sends anything except the room name and document edits to
the server you configure.

## Settings

| Setting | Default (development) | Example for a production server |
| --- | --- | --- |
| `dropdrop.apiUrl` | `http://localhost:5000` | `https://api.your-domain.com` |
| `dropdrop.websocketUrl` | `ws://localhost:5000` | `wss://api.your-domain.com` |
| `dropdrop.publicAppUrl` | `http://localhost:5173` | `https://your-dropdrop.vercel.app` |

- API URLs must start with `http://` or `https://`; the WebSocket URL with `ws://` or `wss://` (`/ws` is added for you).
  Leave `websocketUrl` empty to derive it from `apiUrl`.
- Use `https://` and `wss://` for any server on the internet. The extension rejects `https` + `ws` mixes and warns
  about plain `http`/`ws` to non-local hosts.
- Invalid values produce a notification explaining exactly what to fix, with a button to open the settings.
- The defaults point at a local development server. **Set all three** to your own deployment before sharing rooms
  with other people.

## Running your own server

DropDrop is self-hosted: see the project repository for the backend (Node.js + MongoDB) and website (Vercel)
deployment guide.

## Free hosted servers can be slow to wake

If your DropDrop server runs on a free hosting plan, it may go to sleep when idle. The first request can then take up to
a minute: DropDrop shows *"Waking the DropDrop server. This may take up to a minute."* with a **Cancel** button, and
opens your room as soon as the server answers. A wrong server address is reported immediately instead.

## Known limitations

- Plain text only. Maximum 500,000 characters per room.
- No access control (see the privacy note above).
- One active room per VS Code window.

## License

MIT

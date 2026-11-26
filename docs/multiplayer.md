# Multiplayer

Auvra games can be played online together. Players meet in rooms on a small relay server: each player's game sends its own character to the others, and an authenticated host's game is in charge of shared objects. The relay authorizes room creation and state ownership, but runs no game logic.

## Turning it on

Open **Game Settings** and, under **Multiplayer**:

| Setting | Use |
|---|---|
| Online multiplayer | Connects every play session to the relay |
| Server address | The relay's address, `ws://host:port` or `wss://host:port` (`ws://127.0.0.1:7777` by default) |
| Room | Every player of this build joins this room |
| Max players | How many players a room holds (1 to 16) |

A small badge in the corner of the game shows the connection, the number of players and whether this player is the host. When the relay cannot be reached the game keeps playing offline and keeps trying to connect. Offline gameplay does not confer online host authority.

For protocol version 2, rebuild games and replace their bundled relay together. Older clients and relays are not compatible with this protocol.

## Running the relay

The relay is one Python file with no dependencies beyond Python 3.12 or newer. **Authenticated hosting is the default.** Generate a high-entropy private credential in a trusted terminal:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Set the relay process environment variable `AUVRA_RELAY_HOST_TOKEN` to that value (43–128 URL-safe characters). Keep it out of source control, project settings, game packs, URLs, logs and public chat. Start the relay:

```bash
python -m Auvra.net.relay --port 7777
```

A game built with multiplayer on includes the same relay as `server/relay.py`, with a README. The designated host opens the game's **Host credentials** control in the multiplayer badge (release pointer lock first if needed), enters the private credential and selects **Host room**. It is kept only in the current runtime session's memory, including reconnects; enter it again when a new session is created. Other players use the ordinary connection, without the credential. A bad credential is rejected, and an empty room cannot be reserved by a guest. A second authenticated connection cannot take over an existing room. If the host disconnects, the relay closes that room and its guest connections; clients can retry after the host returns. Guests are never promoted.

The credential grants hosting authority for this relay, not a unique player identity. Use a separate relay/credential for independently administered games and rotate a credential by restarting the relay. This is not a server-authoritative simulation or player account system: guests still control their own avatars and can send ordinary gameplay events; validate event semantics in your game.

Options:

- `--host` (default literal loopback, `127.0.0.1`) and `--port` (default 7777).
- `--max-players` caps players per room (at most 16).
- `--allow-origin URL` (repeatable) restricts browser origins; it is not authentication.
- `--insecure-local` explicitly enables the old first-join/oldest-peer behavior for local testing only. It requires a literal loopback bind and no configured host credential. Never proxy or tunnel this mode to other machines.

For internet players, put the authenticated relay behind a correctly configured TLS reverse proxy and set the game's server address to `wss://`. The host client refuses to transmit a credential to a non-loopback `ws://` address. Built games allow connections to exactly the relay address in Game Settings and nowhere else. For local editor testing, start `python -m Auvra.net.relay --insecure-local --port 7777` with the credential environment variable unset.

## What is shared

- **Players.** Every player sees the others as their player character, moving and animating as they do (position, rotation and the animation graph's Speed, InputX, InputY, IsJumping, IsSprinting, IsAiming, IsFiring and IsDead). Others are drawn about 100 ms in the past so they move smoothly; when their updates stop they keep going for at most 0.2 s, then hold.
- **Objects.** Add a **Network Sync** component to an object the host moves (with a Mover, a Timeline, a script or a blueprint). The host sends its position and rotation, and the other players see it there. On the other players the object follows the host instead of its own movement. The relay rejects level-object state from a non-host and avatar state from anyone but that avatar's owner.
- **Events.** Scripts and level blueprints send named events with a small value to the other players.

Each player's game runs its own level logic, enemies and physics. Use the host for anything that must happen once for everyone, such as spawning a pickup or opening a door, and send an event so the others follow.

## Scripting

In a gameplay script, `ctx.net` gives:

| Call | Does |
|---|---|
| `ctx.net.connected()` | True while connected to the relay |
| `ctx.net.isHost()` | True for the host, and always in single-player games |
| `ctx.net.selfId()` / `ctx.net.peers()` | This player's id, and the other players as `{ id, name }` |
| `ctx.net.send(name, value, toPeerId?)` | Sends an event to every other player, or only to one |

Other players' events arrive in `onNetEvent(ctx, name, value, fromPeerId)`. A value is a number, true/false, text, a list of those, or a flat object of those. See [Gameplay scripting](scripting.md).

```js
function onTriggerEnter(ctx, other, otherId) {
  if (otherId === 'player' && ctx.net.isHost()) {
    ctx.self.setVisible(false);
    ctx.net.send('pickup', ctx.self.id);
  }
}

function onNetEvent(ctx, name, value) {
  if (name === 'pickup' && value === ctx.self.id) ctx.self.setVisible(false);
}
```

## Level blueprints

- **Send Network Event** sends its **Name** and **Value** to the other players.
- **Is Network Host** is true for the host (and in single-player games).
- **Network Event** runs when another player sends an event with its name (leave the name empty to catch every event). Its **Value** output is what they sent, as text, and **From** is their player id.

See [Level scripting](level-scripting.md).

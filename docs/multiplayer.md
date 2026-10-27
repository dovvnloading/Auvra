# Multiplayer

Auvra games can be played online together. Players meet in rooms on a small relay server: each player's game sends its own character to the others, the first player in a room is the host, and the host's game is in charge of shared objects. The relay only passes messages along; it runs no game logic.

## Turning it on

Open **Game Settings** and, under **Multiplayer**:

| Setting | Use |
|---|---|
| Online multiplayer | Connects every play session to the relay |
| Server address | The relay's address, `ws://host:port` or `wss://host:port` (`ws://127.0.0.1:7777` by default) |
| Room | Every player of this build joins this room |
| Max players | How many players a room holds (1 to 16) |

A small badge in the corner of the game shows the connection, the number of players and whether this player is the host. When the relay cannot be reached the game keeps playing offline and keeps trying to connect.

## Running the relay

The relay is one Python file with no dependencies beyond Python 3.12 or newer:

```bash
python -m Auvra.net.relay --port 7777
```

A game built with multiplayer on includes it as `server/relay.py`, with a README, so whoever hosts the game can run `python relay.py --port 7777` on any machine the players can reach. Options:

- `--host` (default all interfaces) and `--port` (default 7777).
- `--max-players` caps players per room (at most 16).
- `--allow-origin URL` (repeatable) accepts only browsers from your game's web origin.

For players connecting over the internet, put the relay behind TLS and use a `wss://` address. Built games allow connections to exactly the relay address in Game Settings and nowhere else. Play in the editor can reach a relay on the same machine at port 7777.

## What is shared

- **Players.** Every player sees the others as their player character, moving and animating as they do (position, rotation and the animation graph's Speed, InputX, InputY, IsJumping, IsSprinting, IsAiming, IsFiring and IsDead). Others are drawn about 100 ms in the past so they move smoothly; when their updates stop they keep going for at most 0.2 s, then hold.
- **Objects.** Add a **Network Sync** component to an object the host moves (with a Mover, a Timeline, a script or a blueprint). The host sends its position and rotation, and the other players see it there. On the other players the object follows the host instead of its own movement.
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

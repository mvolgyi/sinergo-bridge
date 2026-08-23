# Sinergo Bridge — the Foundry VTT module

Sends **your own** Pathfinder 2e character from Foundry to the Sinergo app.

## Why a module at all, when Foundry can already export an actor

Because an export is missing everything that matters. Foundry stores
`system.abilities: null`, `system.skills: {}` and no maximum hit points — the
pf2e system derives all of it at runtime from rule elements. A file import can
therefore never show a trustworthy armour class, which is why one renders as an
em dash (ADR-0003).

This module runs *inside* that runtime and reads the evaluated numbers. The +1
from your armour rune and the −2 from the condition you are under are both in
there, because Foundry has already applied them.

## Why the module pushes and the app listens

Foundry modules are client-side JavaScript. There is **no server-side module
API**: a module that declares `"socket": true` gets `handleCustomSocket` bound
on the server, and that function is a pure relay between browsers — nothing a
module ships ever executes on the server. Verified in the v14.365 source at
`dist/server/sockets.mjs`.

So the app cannot ask Foundry for anything. It listens; the module posts.

## Why that is also the security model

You asked for "each person can only fetch their own character", and this
topology gives it structurally rather than by a permission check we wrote:

- The module runs inside **your** authenticated Foundry session. It can only
  reach documents Foundry already handed to your browser.
- It filters again to `actor.isOwner`, and re-checks at the moment of sending
  rather than only when the list was drawn.
- There is no server component, so there is nothing that could confuse one
  player's request for another's.
- The pairing token is stored at **`client` scope** — localStorage in that one
  browser. `world` or `user` scope would put it in the world database, where
  the GM could read every player's token.

One honest caveat: if you are the **GM**, Foundry counts you as the owner of
every actor, so you will see them all. That is Foundry's own ownership model and
not something to override silently — the dialog says so.

## Installing

**For players, once there is a public release.** Foundry → *Add-on Modules* →
*Install Module*, and paste the manifest URL. This does not work yet: the
manifest in `module.json` points at a GitHub release of a **private**
repository, and Foundry cannot fetch it. Either make a public release or use one
of the routes below.

**Onto a hosted server, over WebDAV.** With the host's credentials in `.env`:

```bash
. .env && ./scripts/install-module.sh
```

It refuses to upload when the server is stopped — a stopped Molten Hosting
server answers *everything* with a redirect to its lobby, so without that check
every file would upload "successfully" into an HTML error page. It also looks
for the `modules` directory rather than assuming where it is, and reads
`module.json` back afterwards instead of trusting a 201.

**By hand.** Build the archive and upload it with whatever file manager the
host gives you:

```bash
./scripts/package-module.sh        # writes dist/sinergo-bridge.zip
```

Upload it into your Foundry data directory under `Data/modules/` and extract it
there, so you end up with:

```
Data/modules/sinergo-bridge/module.json
Data/modules/sinergo-bridge/scripts/bridge.mjs
Data/modules/sinergo-bridge/lang/en.json
```

Then **restart the Foundry server** — a new `module.json` is only read at
startup, so F5 will not find it — and enable it in your world under
*Game Settings → Manage Modules*.

### The one mistake that silently loses you an hour

**The folder must be named exactly `sinergo-bridge`.** Foundry compares the
directory name against the manifest's `id` and rejects the whole module if they
differ, from `dist/packages/package.mjs`:

```js
const a = path.basename(path.dirname(e));
if (s.id !== a) { `Invalid ${this.type} "${s.id}" detected in directory "${a}"` … return null }
```

So `sinergo-bridge-main/`, `foundry-module/` or an extra nesting level all mean
the module never appears in the list — with the reason buried in the server log
rather than shown on screen. The zip above extracts to the right name on its
own, which is why it exists.

**For development.** Symlink the folder into your Foundry data directory:

```bash
ln -s "$PWD/foundry-module/sinergo-bridge" \
      ~/.local/share/FoundryVTT/Data/modules/sinergo-bridge
```

Changing `module.json` needs a **server restart**; changing the script only
needs F5.

## Using it

*Game Settings → Configure Settings → Sinergo companion → Pair and send.*

Pick your character, check the preview line (`AC 26 · Perception 17 · …`) — if
something reads as an em dash there, it will be missing in Sinergo too, and it
is better to find that out here — then **Send**.

### With a hosted Foundry

A hosted world is served over HTTPS, and an HTTPS page cannot make a plain-HTTP
request — *except to loopback*, which browsers treat as trustworthy. So:

- **Sinergo on the same machine as the browser** → use the `http://127.0.0.1:7737`
  address. This works, and it is the normal case for a hosted world.
- **Sinergo on a different machine** (a phone, say) → the browser blocks it.
  Use **Copy instead** and paste into Sinergo's import screen.

Chrome adds one more step for the first case: a public-origin page reaching a
local address gets a Private Network Access preflight, and the listener answers
it with `Access-Control-Allow-Private-Network: true`.

**Copy instead** puts the same payload on the clipboard, and always works.

## Checking the manifest

```bash
pnpm check:foundry
```

Validates `module.json` against **Foundry's own schema class**, loaded out of
the installed client, and adds two checks the schema does not make. It is part
of `pnpm check`, and skips cleanly when no Foundry install is present.

Worth knowing what it found: a manifest with no `version` is *accepted* by
Foundry and silently becomes `"0"`, after which the package manager can never
offer an update.

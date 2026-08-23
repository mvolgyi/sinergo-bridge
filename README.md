# Sinergo Bridge

Sends **your own** Pathfinder 2e character from Foundry VTT to the
[Sinergo](https://github.com/mvolgyi/sinergo) companion app.

## Install

Foundry → **Add-on Modules** → **Install Module**, and paste:

```
https://github.com/mvolgyi/sinergo-bridge/releases/latest/download/module.json
```

Then enable it in your world. Needs the Pathfinder 2e system, Foundry v13 or v14.

## Use it

**Game Settings → Configure Settings → Sinergo companion → Pair and send.**

Pick your character, check the preview line — `AC 26 · Perception 17 · 5 strikes`
— and press **Send**. Anything showing a dash there will be missing in Sinergo
too, and it is better to find that out here.

**Copy instead** puts the same data on the clipboard for pasting into Sinergo's
import screen. Use it when a direct send cannot work.

### Which address to use

Sinergo shows two. Which one works depends on where it is running, not on which
looks more correct:

- **Sinergo on the same computer as this browser** — use the `127.0.0.1` one.
  This works even when Foundry is hosted and served over HTTPS, because browsers
  treat your own machine as trustworthy.
- **Sinergo on another device**, a phone say — use the other address. If Foundry
  is on HTTPS the browser will block it as mixed content; use **Copy instead**.

## Why this exists

A Foundry actor *export* is missing everything that matters. Foundry stores
`system.abilities: null`, `system.skills: {}` and no maximum hit points — the
Pathfinder system works all of it out at load time from your class, your items
and their rule elements. So a file import can never show a trustworthy armour
class, and Sinergo renders one as an em dash rather than a guess.

This module runs *inside* that runtime and reads the evaluated numbers. The
bonus from your armour rune and the penalty from the condition you are under are
both already applied.

## What it can reach

Only characters **you own**. The module runs in your own authenticated Foundry
session, so it can only see documents Foundry already handed your browser, and
it checks ownership again at the moment you press Send.

If you are the **GM**, Foundry counts you as the owner of every actor, so you
will see them all. That is Foundry's own ownership model; the dialog says so
rather than pretending otherwise.

Your pairing token is stored at `client` scope — localStorage in that one
browser. It is deliberately not world or user scope, which would put it in the
world database where the GM could read every player's token.

## Licence

MIT. Sinergo uses trademarks and copyrights owned by Paizo Inc. under Paizo's
Community Use Policy, and is not published, endorsed or approved by Paizo.

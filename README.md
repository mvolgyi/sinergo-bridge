# Sinergo Bridge

Connects a Pathfinder 2e world in Foundry VTT to a campaign in
[Sinergo](https://github.com/mvolgyi/sinergo). The GM connects once with a code; the
party's characters stay in sync, each player sees in Sinergo what Foundry lets
them see, and downtime rewards the GM approves in Sinergo land on the
characters.

## Install (GM)

Foundry → **Add-on Modules** → **Install Module**, and paste:

```
https://github.com/mvolgyi/sinergo-bridge/releases/latest/download/module.json
```

Enable it in your world. Needs the Pathfinder 2e system, Foundry v13 or v14.

## Connect (GM)

One world, one campaign.

1. In Foundry, make sure the player characters are in the **Party** (Actors
   sidebar) and each player is Owner of their character.
2. **Game Settings → Configure Settings → Sinergo → Connect campaign → Get a
   connection code.** The dialog shows an 8-character code and the party
   members it will sync.
3. In Sinergo, open the campaign → **Manage → Foundry** and type the code. The
   dialog in Foundry says it is connected and syncs the party.

From then on, while you have Foundry open, changes to party members — hit
points, conditions, items, permissions — go to Sinergo on their own. Players do
nothing in Foundry.

## Downtime rewards

When you press **Apply in Foundry** on a downtime result in Sinergo, the module
— in your browser, while Foundry is open — adds the gold and items, takes the hit
points, applies the conditions, and posts a chat card. It checks everything
first; if something is missing (an item, enough gold) it changes nothing and
Sinergo shows why. The same result is never applied twice.

## What players see

What their Foundry user can see: every party member's party card (the same
overview pf2e's party sheet shows), the full sheet of characters they own or
observe, and wealth when the world's "Show Party Stats" is on.

## What it sends

The world's users (id, name, GM or not), the pf2e parties and their members,
and each party member's character: the values Foundry computed, its items, and
its permissions. Nothing outside a party is sent. The module makes its sync
token itself and stores it in the GM's browser only; Sinergo only ever receives
its hash while connecting.

## Licence

MIT. Sinergo uses trademarks and copyrights owned by Paizo Inc. under Paizo's
Community Use Policy, and is not published, endorsed or approved by Paizo.

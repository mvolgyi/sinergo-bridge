/**
 * Sinergo Bridge — Foundry VTT v13/v14, Pathfinder 2e.
 *
 * Verified against the installed client source, v14.365, and pf2e 8.3.0.
 *
 * WHY THE MODULE PUSHES AND THE APP LISTENS
 *
 * Foundry modules are client-side JavaScript. There is no server-side module
 * API: `Package#registerCustomSocket` binds `handleCustomSocket`, which is a
 * pure relay between connected browsers, so nothing a module ships ever runs on
 * the server. The app therefore cannot ask Foundry for anything. It listens,
 * and this module — running in your browser, as you — posts to it.
 *
 * WHY THAT IS ALSO THE SECURITY MODEL
 *
 * This code runs inside your own authenticated Foundry session. It can only
 * reach documents Foundry already handed to your browser, and it filters again
 * to `actor.isOwner` before offering anything. There is no path by which one
 * player's pairing reaches another player's character, because there is no
 * server component to confuse about identity.
 *
 * The pairing token is stored at `client` scope — localStorage on this browser
 * only. `world` or `user` scope would put it in the world database, where the
 * GM could read every player's token.
 */

const ID = "sinergo-bridge";
const PROTOCOL = 1;

const t = (key, data) => game.i18n.format(`SINERGO.${key}`, data ?? {});

/** Settings are per-browser on purpose. See the note above about the token. */
Hooks.once("init", () => {
  game.settings.register(ID, "url", {
    scope: "client", config: false, type: String, default: "http://127.0.0.1:7737",
  });
  game.settings.register(ID, "token", {
    scope: "client", config: false, type: String, default: "",
  });

  game.settings.registerMenu(ID, "pair", {
    name: "SINERGO.MenuName",
    label: "SINERGO.MenuLabel",
    hint: "SINERGO.MenuHint",
    icon: "fa-solid fa-link",
    type: SinergoMenu,
    restricted: false,
  });
});

/**
 * Characters this user owns.
 *
 * `isOwner` is true for every actor when you are the GM — that is Foundry's own
 * model, not something to quietly override, so the dialog says so instead.
 */
export function ownedCharacters() {
  return game.actors.filter((a) => a.type === "character" && a.isOwner);
}

/**
 * Read a derived value, or return null.
 *
 * Never a fallback number. A wrong armour class is discovered at the table; a
 * missing one renders as an em dash and is honest. Every read here is optional
 * chained for the same reason.
 */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The snapshot.
 *
 * Derived values, post rule element, which is the entire reason this module
 * exists — an actor *export* carries unevaluated rule elements and a +2 from a
 * potion simply is not in it.
 */
export function snapshot(actor) {
  const sys = actor.system ?? {};
  const stat = (s) => (s ? { total: num(s.mod), rank: num(s.rank) } : null);

  return {
    protocol: PROTOCOL,
    foundry: {
      version: game.version,
      system: game.system?.id ?? null,
      systemVersion: game.system?.version ?? null,
    },
    sentBy: { userId: game.user.id, userName: game.user.name },
    actor: {
      uuid: actor.uuid,
      name: actor.name,
      level: num(sys.details?.level?.value),
      derived: {
        ac: num(actor.armorClass?.value ?? sys.attributes?.ac?.value),
        perception: num(actor.perception?.mod),
        saves: Object.fromEntries(
          ["fortitude", "reflex", "will"].map((k) => [k, stat(actor.saves?.[k])]),
        ),
        skills: Object.fromEntries(
          Object.entries(actor.skills ?? {}).map(([k, s]) => [k, stat(s)]),
        ),
        strikes: (sys.actions ?? []).map((s) => ({
          slug: s.slug ?? null,
          label: s.label ?? null,
          bonus: num(s.totalModifier),
          traits: (s.traits ?? []).map((x) => x?.name ?? x?.value ?? x).filter(Boolean),
        })),
      },
      state: {
        hp: {
          value: num(sys.attributes?.hp?.value),
          max: num(sys.attributes?.hp?.max),
          temp: num(sys.attributes?.hp?.temp) ?? 0,
        },
        heroPoints: num(sys.resources?.heroPoints?.value),
        focus: {
          value: num(sys.resources?.focus?.value),
          max: num(sys.resources?.focus?.max),
        },
        conditions: (actor.conditions?.active ?? []).map((c) => ({
          slug: c.slug ?? null,
          value: num(c.value),
        })),
      },
      /**
       * The actor exactly as `Export Data` would write it.
       *
       * Sent alongside the derived block rather than instead of it, so Sinergo
       * reuses the importer it already has for feats, spells and gear, and only
       * overlays the values an export cannot carry. One code path, not two.
       */
      source: {
        ...actor.toObject(),
        /**
         * Items expanded explicitly.
         *
         * `actor.toObject()` serialises the embedded item collection as an
         * array of **ids**, not objects — measured against a real v14 world,
         * where every character arrived with `items: ["abc123", …]` and the
         * importer rejected all of them. Mapping the collection is the only
         * form that carries the feats, spells and gear.
         */
        items: actor.items.map((i) => i.toObject()),
      },
    },
  };
}

/** Loopback, in the forms a person actually types. */
function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/** One place that talks to the app, so the error copy is consistent. */
export async function post(path, body, { auth = true } = {}) {
  const url = game.settings.get(ID, "url").replace(/\/+$/, "");

  // A page served over HTTPS cannot make a plain-HTTP request — *except* to
  // loopback, which every browser treats as a potentially trustworthy origin
  // and does not block as mixed content.
  //
  // That exception is the main path for a hosted Foundry: the world is on
  // someone else's HTTPS server, but the browser is on the player's own
  // machine, and so is Sinergo. An earlier version of this check blocked
  // 127.0.0.1 too and sent people to the clipboard for no reason.
  if (window.location.protocol === "https:" && url.startsWith("http://") && !isLoopback(url)) {
    throw new Error(t("ErrMixed"));
  }

  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = game.settings.get(ID, "token");
    if (!token) throw new Error(t("ErrNotPaired"));
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    // Keep the original: "Failed to fetch" is useless to the player but is the
    // only thing that distinguishes a wrong port from a firewall in a log.
    throw new Error(t("ErrUnreachable", { url }), { cause: e });
  }
  if (res.status === 401 || res.status === 403) {
    // Drop the dead token. The dialog hides the code field whenever one is
    // stored, so keeping a rejected token leaves no way to pair again — the
    // error told you to do the one thing the screen no longer offered.
    await game.settings.set(ID, "token", "");
    throw new Error(t("ErrAuth"));
  }
  if (!res.ok) throw new Error(`Sinergo replied ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * The dialog's markup, as a function of its inputs.
 *
 * Outside the class so it can be run without Foundry. ApplicationV2 removes the
 * window and rethrows when `_renderHTML` fails, and the settings screen does not
 * catch it — so a throw in here shows the player *nothing at all*, with the
 * reason only in the browser console. That happened, and it is why this is
 * testable now.
 */
export function menuHTML({ actors, url, paired, isGM }) {
  if (!actors.length) {
    return `<p class="notification warning">${t("NoCharacters")}</p>`;
  }

  const options = actors
    .map((a) => `<option value="${a.id}">${foundry.utils.escapeHTML(a.name)}</option>`)
    .join("");

  // Shown before sending, so a derived value we failed to read is visible
  // here as an em dash rather than arriving in Sinergo as a silent gap.
  const s = snapshot(actors[0]);
  const show = (v) => (v === null ? "—" : v);

  return `
    ${isGM ? `<p class="notification info">${t("GMNotice")}</p>` : ""}
    <div class="form-group">
      <label>${t("Character")}</label>
      <select name="actorId">${options}</select>
    </div>
    <div class="form-group">
      <label>${t("Address")}</label>
      <input type="text" name="url" value="${foundry.utils.escapeHTML(url)}">
      <p class="hint">${t("AddressHint")}</p>
    </div>
    <div class="form-group">
      <label>${t("Code")}</label>
      <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
             placeholder="${paired ? t("CodeNotNeeded") : ""}">
      <p class="hint">${t("CodeHint")}</p>
    </div>
    <fieldset>
      <legend>${t("Preview")}</legend>
      <p>AC ${show(s.actor.derived.ac)} ·
         Perception ${show(s.actor.derived.perception)} ·
         ${s.actor.derived.strikes.length} strikes ·
         ${s.actor.source.items?.length ?? 0} items</p>
    </fieldset>
    <footer class="form-footer">
      <button type="button" data-action="copy">${t("Copy")}</button>
      <button type="submit">${t("Send")}</button>
    </footer>`;
  }

class SinergoMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "sinergo-bridge-menu",
    tag: "form",
    window: { title: "SINERGO.DialogTitle", icon: "fa-solid fa-link" },
    position: { width: 460 },
    form: { handler: SinergoMenu.#submit, closeOnSubmit: true },
    actions: { copy: SinergoMenu.#copy },
  };

  async _renderHTML() {
    return menuHTML({
      actors: ownedCharacters(),
      url: game.settings.get(ID, "url"),
      paired: Boolean(game.settings.get(ID, "token")),
      isGM: game.user.isGM,
    });
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  /** Works when the direct POST cannot — HTTPS Foundry, or a firewalled LAN. */
  static async #copy() {
    const id = this.element.querySelector("[name=actorId]")?.value;
    const actor = game.actors.get(id);
    if (!actor?.isOwner) return;
    await game.clipboard.copyPlainText(JSON.stringify(snapshot(actor), null, 2));
    ui.notifications.info(t("Copied"));
  }

  static async #submit(_event, _form, formData) {
    const { actorId, url, code } = formData.object;
    await game.settings.set(ID, "url", url);

    const actor = game.actors.get(actorId);
    // Checked again at the moment of sending, not only when the list was built.
    if (!actor?.isOwner) throw new Error("You do not own that character.");

    try {
      if (code) {
        // The world names itself, so Sinergo can list "The Flock" rather than
        // "Foundry 2" when a player has paired with several.
        const { token } = await post("/pair", {
          code,
          user: game.user.name,
          world: game.world?.title ?? game.world?.id ?? "Foundry",
          origin: window.location.origin,
        }, { auth: false });
        if (!token) throw new Error(t("ErrPair"));
        await game.settings.set(ID, "token", token);
        ui.notifications.info(t("Paired"));
      }
      await post("/actor", snapshot(actor));
      ui.notifications.info(t("Sent", { name: actor.name }));
    } catch (e) {
      ui.notifications.error(e.message, { permanent: true });
      throw e;
    }
  }
}

/** Exported under a second name so tests can drive the transport directly. */
export const postForTest = post;

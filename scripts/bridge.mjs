/**
 * Sinergo Bridge — Foundry VTT v13/v14, Pathfinder 2e.
 *
 * Verified against the installed client source, v14.365, and pf2e 8.3.0.
 *
 * WHAT IT DOES
 *
 * The GM connects the world to a Sinergo campaign once. From then on, while
 * the GM has Foundry open, this module sends Sinergo the world's users, its
 * pf2e parties, and every party member's character — with each actor's
 * ownership, so Sinergo can show each player exactly what Foundry would.
 *
 * WHY THE MODULE PUSHES
 *
 * Foundry modules are client-side JavaScript. There is no server-side module
 * API: `Package#registerCustomSocket` binds `handleCustomSocket`, which is a
 * pure relay between connected browsers, so nothing a module ships ever runs on
 * the server. Sinergo cannot ask Foundry for anything; this module sends.
 *
 * WHY ONLY THE GM
 *
 * Players never configure anything. The sync token is the campaign's, created
 * by its GM in Sinergo and stored at `client` scope — localStorage in the GM's
 * browser, not the world database. When several GMs are connected, only
 * Foundry's active GM sends, so each change arrives once.
 *
 * WHY THE TOKEN IS KEYED BY WORLD
 *
 * A `client` setting is stored under `<module>.<key>` with no world in the key
 * (v14.365 `client/helpers/client-settings.mjs`), and every world on one
 * Foundry host shares the browser origin. One `token` setting therefore
 * followed the GM from world A into world B, and the bridge refused it there.
 * The address and token live in `connections[game.world.id]`.
 *
 * CONNECTING WITH A CODE (ADR-0007)
 *
 * The GM presses "Get a connection code". The module makes the sync token
 * itself, sends the server only its sha256, and shows the code the server
 * returns. The GM types it in Sinergo; the module, polling, sees its token
 * accepted and syncs. The server address comes from `flags.sinergo.server` in
 * module.json, written at release, so the GM does not type it.
 *
 * REWARDS (ADR-0007)
 *
 * While connected, the active GM's browser asks for downtime rewards the GM
 * approved in Sinergo, checks each fully, applies it with pf2e's own APIs, and
 * reports back. An actor flag per attempt keeps a lost reply from applying a
 * reward twice.
 */

const ID = "sinergo-bridge";
const PROTOCOL = 3;
/** Combat moves fast; a burst of HP edits should still be one request. */
const STATE_DEBOUNCE_MS = 800;
/** Item and effect changes carry the whole character, so wait a bit longer. */
const FULL_DEBOUNCE_MS = 2000;
const WORLD_DEBOUNCE_MS = 1500;
const PAIR_POLL_MS = 3000;
const REWARD_POLL_MS = 20000;

const t = (key, data) => game.i18n.format(`SINERGO.${key}`, data ?? {});

Hooks.once("init", () => {
  // { [worldId]: { url, token, campaign } }
  game.settings.register(ID, "connections", {
    scope: "client", config: false, type: Object, default: {},
  });
  // v0.3.0 and earlier: one address and token for every world. Read once, to
  // move them to the world that opens first, then cleared.
  game.settings.register(ID, "url", {
    scope: "client", config: false, type: String, default: "",
  });
  game.settings.register(ID, "token", {
    scope: "client", config: false, type: String, default: "",
  });

  game.settings.registerMenu(ID, "sync", {
    name: "SINERGO.MenuName",
    label: "SINERGO.MenuLabel",
    hint: "SINERGO.MenuHint",
    icon: "fa-solid fa-link",
    type: SinergoMenu,
    // GM only: players never connect anything.
    restricted: true,
  });
});

Hooks.once("ready", async () => {
  await adoptLegacyConnection();
  registerSyncHooks();
  if (isSender() && isConfigured()) {
    await syncAll({ quiet: true });
    pullRewards();
  }
  setInterval(() => pullRewards(), REWARD_POLL_MS);
});

const worldId = () => game.world?.id ?? "";

/** The Sinergo this release was built for; empty in a development checkout. */
export function defaultServer() {
  const server = game.modules?.get?.(ID)?.flags?.sinergo?.server;
  return typeof server === "string" ? server : "";
}

/** This world's address, token and campaign name; empty strings when not connected. */
export function connection() {
  const all = game.settings.get(ID, "connections") || {};
  const mine = all[worldId()] ?? {};
  return {
    url: String(mine.url || defaultServer()),
    token: String(mine.token ?? ""),
    campaign: String(mine.campaign ?? ""),
  };
}

export async function setConnection({ url, token, campaign }) {
  const all = { ...(game.settings.get(ID, "connections") || {}) };
  const current = connection();
  all[worldId()] = {
    url: url ?? current.url,
    token: token ?? current.token,
    campaign: campaign ?? (token && token !== current.token ? "" : current.campaign),
  };
  await game.settings.set(ID, "connections", all);
}

/**
 * The first world opened after upgrading keeps the old single token — the
 * common case is one GM, one world. If it belonged to another world, the
 * bridge answers "connected to another Foundry world" and the GM pastes this
 * world's token, as they would have had to anyway.
 */
export async function adoptLegacyConnection() {
  const url = game.settings.get(ID, "url");
  const token = game.settings.get(ID, "token");
  if (!url && !token) return false;
  if (!connection().token) await setConnection({ url, token });
  await game.settings.set(ID, "url", "");
  await game.settings.set(ID, "token", "");
  return true;
}

/**
 * Read a derived value, or return null.
 *
 * Never a fallback number. A wrong armour class is discovered at the table; a
 * missing one renders as an em dash and is honest.
 */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** An image path as a URL Sinergo can load from outside Foundry. */
export function absoluteUrl(path) {
  if (!path) return null;
  try {
    return new URL(path, `${window.location.origin}/`).href;
  } catch {
    return null;
  }
}

/** This browser should send: a GM, and the active GM when there are several. */
export function isSender() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM;
  return !active || active.id === game.user.id;
}

const isConfigured = () => {
  const { url, token } = connection();
  return Boolean(url && token);
};

/** pf2e parties in this world. */
export function parties() {
  return game.actors.filter((a) => a.type === "party");
}

/**
 * The characters Sinergo follows: members of any pf2e party.
 *
 * `PartyPF2e#members` is prepared from `system.details.members` in
 * `prepareBaseData`. A template like "Player Character" is in no party and is
 * never sent.
 */
export function partyCharacters() {
  const seen = new Map();
  for (const party of parties()) {
    for (const member of party.members ?? []) {
      if (member?.type === "character") seen.set(member.uuid, member);
    }
  }
  return [...seen.values()];
}

const inParty = (actor) =>
  actor?.type === "character" && parties().some((p) => (p.members ?? []).some((m) => m?.uuid === actor.uuid));

/**
 * The values that change during play, post rule element.
 *
 * Paths checked against pf2e 8.3.0's bundle, not recalled:
 * `actor.classDC` is a Statistic set from the primary class DC,
 * `actor.attributes.{dying,wounded,shield}` are prepared on the document,
 * speeds are `system.movement.speeds.<type>.value`, and senses are
 * `actor.perception.senses`, a Collection of Sense with `type` and `label`.
 */
/**
 * A strike's damage, the way pf2e's own sheet gets it.
 *
 * "1d6+3 piercing" is not the weapon's `system.damage` — runes add dice,
 * the ability modifier adds to the total, and rule elements add more. The only
 * honest source is the strike's own `damage({ getFormula: true })`, which is
 * async and is why `live()` is. A weapon that deals no damage, or an error
 * inside someone's rule element, gives null rather than a guess (ADR-0003).
 */
async function damageFormula(strike) {
  if (!strike?.item?.dealsDamage || typeof strike.damage !== "function") return null;
  try {
    const formula = await strike.damage({ getFormula: true });
    return typeof formula === "string" && formula.trim() ? formula : null;
  } catch {
    return null;
  }
}

export async function live(actor) {
  const sys = actor.system ?? {};
  const attrs = actor.attributes ?? sys.attributes ?? {};
  const stat = (s) => (s ? { total: num(s.mod), rank: num(s.rank) } : null);
  const shield = attrs.shield;

  /*
   * `actor.inventory.bulk` is pf2e's own InventoryBulk: `value` is a Bulk
   * object whose `.value` is the decimal total (4.6), `encumberedAfter` is
   * 5 + Str and `max` is 10 + Str. Summing item bulk in the web app would get
   * containers and the light-bulk rule wrong, so the weighing stays here.
   */
  const bulk = actor.inventory?.bulk;

  return {
    derived: {
      ac: num(actor.armorClass?.value ?? sys.attributes?.ac?.value),
      bulk: {
        value: num(bulk?.value?.value),
        encumberedAfter: num(bulk?.encumberedAfter),
        max: num(bulk?.max),
      },
      perception: stat(actor.perception),
      classDC: num(actor.classDC?.dc?.value),
      speed: num(sys.movement?.speeds?.land?.value),
      speeds: Object.entries(sys.movement?.speeds ?? {})
        .map(([type, s]) => ({ type, value: num(s?.value) }))
        .filter((s) => s.value !== null),
      senses: [...(actor.perception?.senses ?? [])].map((s) => ({
        type: s?.type ?? null,
        label: s?.label ?? null,
      })),
      // `CharacterPF2e#abilities` is a clone of `system.abilities` after build
      // boosts. A partial boost past +4 leaves a .5 here; the sheet floors it.
      attributes: Object.fromEntries(
        Object.entries(actor.abilities ?? {}).map(([k, a]) => [k, num(a?.mod)]),
      ),
      saves: Object.fromEntries(
        ["fortitude", "reflex", "will"].map((k) => [k, stat(actor.saves?.[k])]),
      ),
      skills: Object.fromEntries(
        Object.entries(actor.skills ?? {}).map(([k, s]) => [k, { ...stat(s), label: s?.label ?? null }]),
      ),
      strikes: await Promise.all(
        (sys.actions ?? []).map(async (s) => ({
          slug: s.slug ?? null,
          label: s.label ?? null,
          itemId: s.item?.id ?? null,
          bonus: num(s.totalModifier),
          // The multiple-attack-penalty ladder exactly as the sheet shows it.
          variants: (s.variants ?? []).map((v) => v?.label ?? null).filter(Boolean),
          damage: await damageFormula(s),
          traits: (s.traits ?? []).map((x) => x?.name ?? x?.value ?? x).filter(Boolean),
        })),
      ),
      spellcasting: (actor.spellcasting?.contents ?? [])
        .filter((e) => e?.statistic)
        .map((e) => ({
          id: e.id ?? null,
          name: e.name ?? null,
          attack: num(e.statistic?.mod),
          dc: num(e.statistic?.dc?.value),
        })),
    },
    state: {
      hp: {
        value: num(sys.attributes?.hp?.value),
        max: num(sys.attributes?.hp?.max),
        temp: num(sys.attributes?.hp?.temp) ?? 0,
      },
      heroPoints: { value: num(actor.heroPoints?.value ?? sys.resources?.heroPoints?.value), max: num(actor.heroPoints?.max) },
      focus: {
        value: num(sys.resources?.focus?.value),
        max: num(sys.resources?.focus?.max),
      },
      dying: { value: num(attrs.dying?.value), max: num(attrs.dying?.max) },
      wounded: { value: num(attrs.wounded?.value), max: num(attrs.wounded?.max) },
      shield: shield?.itemId
        ? {
            name: shield.name ?? null,
            ac: num(shield.ac),
            hardness: num(shield.hardness),
            hp: { value: num(shield.hp?.value), max: num(shield.hp?.max) },
            // Half the maximum, but pf2e's half, not ours.
            brokenThreshold: num(shield.brokenThreshold ?? shield.hp?.brokenThreshold),
            raised: Boolean(shield.raised),
            broken: Boolean(shield.broken),
          }
        : null,
      conditions: (actor.conditions?.active ?? []).map((c) => ({
        slug: c.slug ?? null,
        name: c.name ?? null,
        value: num(c.value),
        img: absoluteUrl(c.img),
      })),
    },
  };
}

/**
 * Coins and total wealth. `ActorInventory#coins` and `#totalWealth` are Coins
 * objects with pp/gp/sp/cp and `copperValue`. Sent apart from the sheet because
 * pf2e shows them to other players only under "Show Party Stats".
 */
export function wealth(actor) {
  const coins = actor.inventory?.coins;
  const total = actor.inventory?.totalWealth;
  if (!coins && !total) return null;
  const pick = (c) => (c ? { pp: num(c.pp) ?? 0, gp: num(c.gp) ?? 0, sp: num(c.sp) ?? 0, cp: num(c.cp) ?? 0 } : null);
  return {
    currency: pick(coins),
    totalCp: num(total?.copperValue),
  };
}

/** Foundry's own permission record: `{ default: 0..3, <userId>: -1..3 }`. */
const ownership = (actor) => ({ ...(actor.ownership ?? {}) });

const partyUuids = (actor) =>
  parties().filter((p) => (p.members ?? []).some((m) => m?.uuid === actor.uuid)).map((p) => p.uuid);

function envelope(body) {
  return {
    protocol: PROTOCOL,
    foundry: {
      version: game.version,
      system: game.system?.id ?? null,
      systemVersion: game.system?.version ?? null,
    },
    world: {
      id: game.world?.id ?? null,
      title: game.world?.title ?? null,
      origin: window.location.origin,
    },
    ...body,
  };
}

/** Users, parties and the party-stats setting. */
export function worldUpdate() {
  let partyStats = null;
  try {
    partyStats = Boolean(game.settings.get("pf2e", "metagame_showPartyStats"));
  } catch {
    // Not registered: not pf2e, or a version that renamed it. Sinergo keeps its default.
  }
  return envelope({
    partyStats,
    users: game.users.map((u) => ({ id: u.id, name: u.name, isGM: Boolean(u.isGM) })),
    parties: parties().map((p) => ({
      uuid: p.uuid,
      name: p.name,
      img: absoluteUrl(p.img),
      members: (p.members ?? []).map((m) => m?.uuid).filter(Boolean),
    })),
  });
}

/**
 * The character's portrait, small enough to keep: a webp of at most 512 px.
 *
 * Art inside a world (`worlds/<id>/…`) is served by the Foundry server, which
 * is asleep between sessions — exactly when players look at Sinergo. This
 * browser is logged in to Foundry, so it can read the file; Sinergo keeps the
 * copy and the card has a face with Foundry off. A CDN image that refuses
 * cross-origin reads stays a URL, which is fine: a CDN is always up.
 */
const portraits = new Map();

export async function portrait(url, { maxSize = 512, quality = 0.82, limit = 300_000 } = {}) {
  if (!url) return null;
  if (portraits.has(url)) return portraits.get(url);
  let data = null;
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`Sinergo: portrait ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    data = blob.size * 1.4 > limit ? null : await blobToDataUrl(blob);
    if (data && data.length > limit) data = null;
  } catch {
    // Unreadable (cross-origin, gone, an old browser): the URL still stands.
    data = null;
  }
  portraits.set(url, data);
  return data;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The whole character: live values, wealth, permissions, and the actor. */
export async function snapshot(actor) {
  return envelope({
    actor: {
      uuid: actor.uuid,
      name: actor.name,
      level: num(actor.system?.details?.level?.value),
      img: absoluteUrl(actor.img),
      ownership: ownership(actor),
      parties: partyUuids(actor),
      wealth: wealth(actor),
      ...(await live(actor)),
      source: {
        ...actor.toObject(),
        /**
         * Items expanded explicitly. `actor.toObject()` serialises the embedded
         * collection as ids, not objects — measured against a real v14 world.
         *
         * Each icon becomes a URL Sinergo can load. A world's paths are
         * relative to the Foundry that serves them ("systems/pf2e/icons/…"),
         * which means nothing in a browser pointed at Sinergo; a hosted world
         * already carries absolute ones, and those are left alone.
         */
        items: actor.items.map((i) => {
          const item = i.toObject();
          return { ...item, img: absoluteUrl(item.img) ?? item.img ?? null };
        }),
      },
    },
  });
}

/** Only what moves in play. Small, because it is sent on every HP change. */
export async function stateUpdate(actor) {
  return envelope({ actor: { uuid: actor.uuid, ownership: ownership(actor), ...(await live(actor)) } });
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

class BridgeError extends Error {
  constructor(message, { status, needFull, cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.needFull = needFull;
  }
}

/** One place that talks to the server, so the error copy is consistent. */
export async function post(path, body) {
  const current = connection();
  if (!current.url.trim() || !current.token.trim()) throw new BridgeError(t("ErrNotConfigured"));
  return request(current.url, path, body, current.token.trim());
}

/** A request to a given server, with a token or (for pairing) without one. */
async function request(rawUrl, path, body, token) {
  const url = rawUrl.trim().replace(/\/+$/, "");

  // An HTTPS page cannot make a plain-HTTP request, except to loopback, which
  // browsers treat as trustworthy — a local Supabase during development.
  if (window.location.protocol === "https:" && url.startsWith("http://") && !isLoopback(url)) {
    throw new BridgeError(t("ErrMixed"));
  }

  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new BridgeError(t("ErrUnreachable", { url }), { cause: e });
  }
  if (res.status === 401) throw new BridgeError(t("ErrAuth"), { status: 401 });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // An HTML error page from a proxy; the status below says enough.
  }
  if (res.status === 409 && data?.wrongWorld) throw new BridgeError(t("ErrWrongWorld"), { status: 409 });
  if (res.status === 409) throw new BridgeError(t("ErrProtocol"), { status: 409 });
  if (!res.ok) {
    throw new BridgeError(data?.error ?? `Sinergo replied ${res.status}`, {
      status: res.status,
      needFull: Boolean(data?.needFull),
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Staying in sync
// ---------------------------------------------------------------------------

const timers = new Map();
/** Per actor: a pending full send absorbs any pending state send. */
const pendingFull = new Set();
/** One warning per failure kind, not one per hit point. */
let lastWarned = null;

function warnOnce(e) {
  if (lastWarned === e.message) return;
  lastWarned = e.message;
  ui.notifications.warn(`Sinergo: ${e.message}`);
}

export async function sendWorld() {
  try {
    await post("/world", worldUpdate());
    lastWarned = null;
    return true;
  } catch (e) {
    warnOnce(e);
    return false;
  }
}

export async function sendState(actor) {
  try {
    await post("/state", await stateUpdate(actor));
    lastWarned = null;
  } catch (e) {
    // Sinergo has never seen this character: send all of it instead.
    if (e.needFull) return sendFull(actor);
    warnOnce(e);
  }
}

export async function sendFull(actor) {
  try {
    const body = await snapshot(actor);
    body.actor.portrait = await portrait(body.actor.img);
    await post("/actor", body);
    lastWarned = null;
    return true;
  } catch (e) {
    warnOnce(e);
    return false;
  }
}

/** World first, so parties exist when their members arrive; then each member. */
export async function syncAll({ quiet = false } = {}) {
  if (!(await sendWorld())) return { sent: 0, failed: true };
  let sent = 0;
  for (const actor of partyCharacters()) {
    if (await sendFull(actor)) sent++;
  }
  if (!quiet) ui.notifications.info(t("Synced", { count: sent }));
  return { sent, failed: false };
}

function debounce(key, ms, fn) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fn();
  }, ms));
}

export function schedule(actor, kind) {
  if (!isSender() || !isConfigured() || !inParty(actor)) return;
  if (kind === "full") pendingFull.add(actor.uuid);
  else if (pendingFull.has(actor.uuid)) return;

  const full = pendingFull.has(actor.uuid);
  debounce(actor.uuid, full ? FULL_DEBOUNCE_MS : STATE_DEBOUNCE_MS, () => {
    pendingFull.delete(actor.uuid);
    // Re-read the actor: the one captured by the hook may be stale.
    const fresh = game.actors.get(actor.id) ?? actor;
    return full ? sendFull(fresh) : sendState(fresh);
  });
}

/** Membership or users changed: resend the world, then every current member. */
export function scheduleWorld() {
  if (!isSender() || !isConfigured()) return;
  debounce("__world__", WORLD_DEBOUNCE_MS, async () => {
    if (!(await sendWorld())) return;
    for (const actor of partyCharacters()) schedule(actor, "full");
  });
}

/**
 * Conditions and effects are embedded items in pf2e, so an item hook covers a
 * condition being applied as well as a feat being learned. Derived values are
 * already recomputed when these hooks fire: a ClientDocument prepares its data
 * in `_initialize` before the update hook is called.
 */
export function registerSyncHooks() {
  Hooks.on("updateActor", (actor) => {
    if (actor.type === "party") scheduleWorld();
    else schedule(actor, "state");
  });
  Hooks.on("createActor", (actor) => actor.type === "party" && scheduleWorld());
  Hooks.on("deleteActor", (actor) => (actor.type === "party" || actor.type === "character") && scheduleWorld());
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, (item) => schedule(item.parent, "full"));
  }
  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hook, (effect) => schedule(effect.parent?.parent ?? effect.parent, "full"));
  }
  for (const hook of ["createUser", "updateUser", "deleteUser"]) {
    Hooks.on(hook, () => scheduleWorld());
  }
  Hooks.on("updateSetting", (setting) => setting.key === "pf2e.metagame_showPartyStats" && scheduleWorld());
}

// ---------------------------------------------------------------------------
// Connecting with a code (ADR-0007)
// ---------------------------------------------------------------------------

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A new sync token: 32 random bytes. It never leaves this browser except as a bearer header. */
export function newToken(bytes = crypto.getRandomValues(new Uint8Array(32))) {
  return `snrg_${hex(bytes)}`;
}

/**
 * sha256, hex. `crypto.subtle` exists only in a secure context, and a Foundry
 * served as http://192.168.x.x:30000 is not one, so there is a plain version.
 */
export async function sha256Hex(text) {
  if (globalThis.crypto?.subtle && globalThis.isSecureContext !== false) {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
  }
  return sha256Plain(text);
}

export function sha256Plain(text) {
  const K = [];
  const H = [];
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  for (let n = 2, found = 0; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (found < 8) H.push(frac(Math.sqrt(n)));
    K.push(frac(Math.cbrt(n)));
    found++;
  }
  const bytes = [...new TextEncoder().encode(text), 0x80];
  const bitLength = (bytes.length - 1) * 8;
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLength >>> (i * 8)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map((v) => v.toString(16).padStart(8, "0")).join("");
}

/** Ask the server for a code. The token stays here; the server gets its hash. */
export async function requestCode(url) {
  if (!url?.trim()) throw new BridgeError(t("ErrNoServer"));
  const token = newToken();
  const data = await request(url, "/pair", envelope({ tokenHash: await sha256Hex(token) }), null);
  return { url: url.trim(), token, code: String(data?.code ?? ""), expiresAt: Date.now() + (data?.expiresInSeconds ?? 600) * 1000 };
}

/** "waiting", "expired", or the campaign's name once the GM typed the code. */
export async function pollCode(pairing) {
  try {
    const data = await request(pairing.url, "/poll", envelope({}), pairing.token);
    if (data?.status !== "connected") return Date.now() > pairing.expiresAt ? "expired" : "waiting";
    const campaign = String(data.campaign ?? "");
    await setConnection({ url: pairing.url, token: pairing.token, campaign });
    return { campaign };
  } catch (e) {
    if (e.status === 410) return "expired";
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Rewards the GM approved (ADR-0007)
// ---------------------------------------------------------------------------

/** A copper amount as pf2e coins: 250 → { gp: 2, sp: 5, cp: 0 }. */
export const coinsFromCopper = (cp) => ({ pp: 0, gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 });

const coinText = (cp) => {
  const c = coinsFromCopper(cp);
  return [c.gp && `${c.gp} gp`, c.sp && `${c.sp} sp`, c.cp && `${c.cp} cp`].filter(Boolean).join(" ") || "0 gp";
};

/**
 * Apply one reward to its character, or change nothing and say why.
 *
 * Everything is checked before anything is written: the character is in this
 * world, every item resolves to a physical item, there is gold enough to take,
 * every condition exists. pf2e's own APIs do the writing, so stacking, making
 * change and condition values behave as they do on the sheet.
 */
export async function applyReward(reward) {
  const actor = game.actors.find((a) => a.uuid === reward.characterUuid);
  const name = actor?.name ?? reward.characterName ?? "?";
  if (!actor || actor.type !== "character") return { ok: false, note: t("RewardNoCharacter", { name }) };

  const flagKey = `rewards.${reward.attemptId}`;
  const earlier = actor.getFlag?.(ID, "rewards")?.[reward.attemptId];
  if (earlier === "done") return { ok: true, note: t("RewardAlready") };
  if (earlier === "partial") return { ok: false, note: t("RewardPartial", { name }) };

  const items = [];
  for (const entry of reward.items ?? []) {
    const doc = await Promise.resolve(fromUuid(entry.uuid)).catch(() => null);
    if (!doc || doc.documentName !== "Item" || !doc.isOfType?.("physical")) {
      return { ok: false, note: t("RewardNoItem", { item: entry.name || entry.uuid }) };
    }
    items.push({ doc, quantity: Math.max(1, Math.trunc(entry.quantity ?? 1)) });
  }
  const copper = Math.round((reward.gp ?? 0) * 100);
  const has = actor.inventory?.coins?.copperValue ?? 0;
  if (copper < 0 && has < -copper) {
    return { ok: false, note: t("RewardNoGold", { name, need: coinText(-copper), has: coinText(has) }) };
  }
  const conditions = [];
  for (const c of reward.conditions ?? []) {
    const condition = game.pf2e?.ConditionManager?.getCondition?.(c.slug);
    if (!condition) return { ok: false, note: t("RewardNoCondition", { slug: c.slug }) };
    conditions.push({ slug: c.slug, value: c.value ?? null, label: `${condition.name}${c.value ? ` ${c.value}` : ""}` });
  }
  const hp = actor.system?.attributes?.hp?.value;
  if (reward.hpLoss && typeof hp !== "number") return { ok: false, note: t("RewardNoHP", { name }) };

  const parts = [];
  await actor.setFlag(ID, flagKey, "partial");
  try {
    if (copper > 0) {
      await actor.inventory.addCoins(coinsFromCopper(copper));
      parts.push(`+${coinText(copper)}`);
    } else if (copper < 0) {
      if (!(await actor.inventory.removeCoins(coinsFromCopper(-copper)))) throw new Error(t("RewardNoGold", { name, need: coinText(-copper), has: coinText(has) }));
      parts.push(`−${coinText(-copper)}`);
    }
    for (const { doc, quantity } of items) {
      const source = doc.toObject();
      source.system.quantity = quantity;
      await actor.addToInventory(source);
      parts.push(`${doc.name} ×${quantity}`);
    }
    if (reward.hpLoss) {
      await actor.update({ "system.attributes.hp.value": Math.max(0, hp - reward.hpLoss) });
      parts.push(`−${reward.hpLoss} HP`);
    }
    for (const c of conditions) {
      await actor.increaseCondition(c.slug, c.value ? { value: c.value } : {});
      parts.push(c.label);
    }
  } catch (e) {
    return { ok: false, note: t("RewardStopped", { name, error: e?.message ?? String(e) }) };
  }
  await actor.setFlag(ID, flagKey, "done");

  const note = parts.join(" · ") || t("RewardNothing");
  try {
    const esc = foundry.utils.escapeHTML;
    await ChatMessage.create({
      speaker: { alias: actor.name },
      content: `<p><strong>${esc(t("RewardChatTitle"))}</strong> — ${esc(reward.activity ?? "")}</p><p>${esc(note)}</p>`,
    });
  } catch {
    // The reward is applied; a chat card is a courtesy.
  }
  return { ok: true, note };
}

let pulling = false;

/** Ask for approved rewards and apply them. Returns how many were applied. */
export async function pullRewards() {
  if (pulling || !isSender() || !isConfigured()) return 0;
  pulling = true;
  let applied = 0;
  try {
    const data = await post("/rewards", envelope({}));
    for (const reward of data?.rewards ?? []) {
      const result = await applyReward(reward);
      await post("/ack", envelope({ attemptId: reward.attemptId, ok: result.ok, note: result.note }));
      if (result.ok) {
        applied++;
        ui.notifications.info(t("RewardApplied", { name: reward.characterName, note: result.note }));
      } else {
        ui.notifications.warn(`Sinergo: ${result.note}`);
      }
    }
    lastWarned = null;
  } catch (e) {
    warnOnce(e);
  } finally {
    pulling = false;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// The dialog — GM only
// ---------------------------------------------------------------------------

/**
 * The dialog's markup, as a function of its inputs.
 *
 * Outside the class so it can be run without Foundry. ApplicationV2 removes the
 * window and rethrows when `_renderHTML` fails, and the settings screen does not
 * catch it — so a throw in here shows the GM *nothing at all*.
 */
export function menuHTML({ partyList, characters, url, defaultUrl = "", hasToken, campaign = "", pairing = null, message = "", isActiveGM }) {
  const esc = foundry.utils.escapeHTML;
  const show = (v) => (v === null || v === undefined ? "—" : v);

  const members = characters.length
    ? `<ul class="sinergo-members">${characters
        .map((a) => {
          // Read straight off the actor rather than through `live()`, which is
          // async now that it asks pf2e for damage formulas. This menu must stay
          // synchronous: a throw in here shows the GM nothing at all.
          const ac = num(a.armorClass?.value ?? a.system?.attributes?.ac?.value);
          const hp = a.system?.attributes?.hp ?? {};
          return `<li>${esc(a.name)} — AC ${show(ac)} · HP ${show(num(hp.value))}/${show(num(hp.max))}</li>`;
        })
        .join("")}</ul>`
    : `<p class="notification warning">${t("NoPartyMembers")}</p>`;

  const connect = pairing
    ? `<div class="sinergo-pairing">
        <p>${t("CodeSteps")}</p>
        <p class="sinergo-code" style="font-size:2em;font-family:monospace;letter-spacing:.15em;text-align:center;margin:.4em 0">${esc(pairing.code)}</p>
        <p class="hint">${t("CodeWaiting", { minutes: Math.max(1, Math.ceil((pairing.expiresAt - Date.now()) / 60000)) })}</p>
        <button type="button" data-action="cancelCode">${t("Cancel")}</button>
      </div>`
    : hasToken
      ? `<p class="notification info">${campaign ? t("ConnectedTo", { campaign: esc(campaign) }) : t("Connected")}</p>
         <div class="flexrow" style="gap:.5em">
           <button type="button" data-action="syncNow">${t("SyncNow")}</button>
           <button type="button" data-action="getCode">${t("Reconnect")}</button>
         </div>`
      : `<p>${t("ConnectIntro")}</p>
         <button type="button" data-action="getCode">${t("GetCode")}</button>
         ${url ? "" : `<p class="notification warning">${t("ErrNoServer")}</p>`}`;

  return `
    ${isActiveGM ? "" : `<p class="notification info">${t("NotActiveGM")}</p>`}
    ${message ? `<p class="notification warning">${esc(message)}</p>` : ""}
    ${connect}
    <fieldset>
      <legend>${t("Preview", { parties: partyList.map((p) => esc(p.name)).join(", ") || "—" })}</legend>
      ${members}
    </fieldset>
    <details ${url ? "" : "open"}>
      <summary>${t("Advanced")}</summary>
      <div class="form-group">
        <label>${t("Address")}</label>
        <input type="url" name="url" value="${esc(url)}" placeholder="${esc(defaultUrl || "https://….supabase.co/functions/v1/bridge")}">
        <p class="hint">${t("AddressHint")}</p>
      </div>
      <div class="form-group">
        <label>${t("Token")}</label>
        <input type="password" name="token" autocomplete="off"
               placeholder="${hasToken ? t("TokenStored") : "snrg_…"}">
        <p class="hint">${t("TokenHint")}</p>
      </div>
      <footer class="form-footer">
        <button type="submit">${t("Send")}</button>
      </footer>
    </details>`;
}

class SinergoMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "sinergo-bridge-menu",
    tag: "form",
    window: { title: "SINERGO.DialogTitle", icon: "fa-solid fa-link" },
    position: { width: 480 },
    form: { handler: SinergoMenu.#submit, closeOnSubmit: true },
    actions: {
      getCode: SinergoMenu.#getCode,
      cancelCode: SinergoMenu.#cancelCode,
      syncNow: SinergoMenu.#syncNow,
    },
  };

  /** The code on screen, while the GM types it in Sinergo. */
  pairing = null;
  message = "";
  #timer = null;

  async _renderHTML() {
    const { url, token, campaign } = connection();
    return menuHTML({
      partyList: parties(),
      characters: partyCharacters(),
      url,
      defaultUrl: defaultServer(),
      hasToken: Boolean(token),
      campaign,
      pairing: this.pairing,
      message: this.message,
      isActiveGM: isSender(),
    });
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onClose(options) {
    clearInterval(this.#timer);
    this.pairing = null;
    super._onClose?.(options);
  }

  static async #getCode() {
    if (!game.user.isGM) return;
    this.message = "";
    const form = this.element?.querySelector?.("input[name=url]");
    try {
      this.pairing = await requestCode(form?.value || connection().url);
      // Keep the address the GM typed, so the field still shows it.
      if (this.pairing.url !== connection().url) await setConnection({ url: this.pairing.url });
    } catch (e) {
      this.message = e.message;
      return this.render();
    }
    clearInterval(this.#timer);
    this.#timer = setInterval(async () => {
      if (!this.pairing) return clearInterval(this.#timer);
      let result;
      try {
        result = await pollCode(this.pairing);
      } catch (e) {
        this.message = e.message;
        result = "waiting";
      }
      if (result === "waiting") return this.render();
      clearInterval(this.#timer);
      this.pairing = null;
      if (result === "expired") {
        this.message = t("CodeExpired");
        return this.render();
      }
      ui.notifications.info(t("ConnectedTo", { campaign: result.campaign }));
      await this.render();
      await syncAll();
      pullRewards();
    }, PAIR_POLL_MS);
    this.render();
  }

  static #cancelCode() {
    clearInterval(this.#timer);
    this.pairing = null;
    this.render();
  }

  static async #syncNow() {
    await syncAll();
    pullRewards();
  }

  static async #submit(_event, _form, formData) {
    if (!game.user.isGM) throw new Error("Only the GM connects Sinergo.");
    const { url, token } = formData.object;
    // An empty token field means "keep the stored one".
    await setConnection({ url: url ?? "", token: token ? token.trim() : undefined });
    const { failed } = await syncAll();
    if (failed) throw new Error(t("SyncFailed"));
    pullRewards();
  }
}

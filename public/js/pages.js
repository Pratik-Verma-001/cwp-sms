import { api, ago, ApiFail, ask, clear, copy, countUp, h, icon, longPress, sheet, splash, statusPill, toast, when } from "./core.js";

export const state = { lastConnectorSecret: null, lastConnectorKeyId: null };

const BASE = () => location.origin;
const head = (title, sub, ...actions) =>
  h("div", { class: "page-head" }, h("div", {}, h("h1", { text: title }), sub ? h("p", { text: sub }) : null), h("div", { class: "row" }, ...actions));

export function codeBlock(text) {
  return h("div", { class: "codewrap" },
    h("pre", { class: "code" }, h("code", { text })),
    h("button", { class: "btn small", type: "button", onclick: () => copy(text), text: "Copy" }));
}

function loading() { return splash("Loading…", true); }
function failure(e, retry) {
  return h("div", { class: "banner bad" }, h("div", {}, h("b", { text: "Could not load this page" }), h("span", { text: e.message || "Unexpected error." }),
    " ", h("button", { class: "btn small", type: "button", onclick: retry, text: "Try again" })));
}

/** Renders `view` into `root`, showing a loader first and a retry on failure. */
async function mount(root, load, view) {
  const gen = (root._gen = (root._gen || 0) + 1); // a newer render of this spot wins; stale replies are dropped
  const t = setTimeout(() => { if (root._gen === gen) clear(root).append(loading()); }, 140);
  try { const data = await load(); clearTimeout(t); if (root._gen !== gen) return; clear(root).append(...[].concat(view(data))); }
  catch (e) { clearTimeout(t); if (root._gen !== gen) return; clear(root).append(failure(e, () => mount(root, load, view))); }
}

/* ------------------------------ Overview ------------------------------ */
export function overview(root) {
  mount(root, () => api("GET", "/dashboard"), (d) => {
    const c = d.counts;
    const live = d.account.liveSendingAllowed;
    const pct = Math.min(100, Math.round((d.quota.usedUnits / d.quota.dailyUnits) * 100));
    const bar = h("i"); bar.style.width = pct + "%";
    const stat = (label, num, hint, cls = "") => { const n = h("div", { class: "num" }); countUp(n, num); return h("div", { class: "stat " + cls }, h("div", { class: "label", text: label }), n, hint ? h("div", { class: "hint", text: hint }) : null); };

    const hasConnector = d.keys.connectorKeys > 0, hasApi = d.keys.apiKeys > 0, online = d.devices.online > 0;
    const todo = [
      [hasConnector, "Create a connector key", "#/keys"],
      [online, "Install the SDK and bring your phone online", "#/sdk"],
      [hasApi, "Create an API key for your server", "#/keys"],
      [live, "Live sending enabled (platform + account)", null],
    ];

    return [
      head("Overview", `Today is ${d.quota.day} (UTC).`, h("button", { class: "btn", type: "button", onclick: () => overview(root), text: "Refresh" })),
      h("div", { class: "stack" },
        live
          ? h("div", { class: "banner ok" }, h("div", {}, h("b", { text: "Live sending is on" }), "Messages from live API keys will be sent through your phone's SIM."))
          : h("div", { class: "banner warn" }, h("div", {}, h("b", { text: "Live sending is off" }),
              d.account.liveSendingEnabledOnPlatform ? "Your account is not yet enabled for live sending. Demo requests still work." : "The platform has live sending switched off. Demo requests still work.")),
        h("div", { class: "grid stats" },
          stat("Pending", c.pending, "queued, assigned or sending", "pending"),
          stat("Sent", c.sent, "incl. delivered"),
          stat("Delivered", c.delivered, "confirmed by carrier"),
          stat("Failed / expired", c.failed)),
        h("div", { class: "grid two" },
          h("div", { class: "card" },
            h("div", { class: "row" }, h("h2", { text: "Recent requests" }), h("span", { class: "spacer" }), h("a", { class: "btn small primary", href: "#/requests", text: "View all" })),
            d.recent.length === 0
              ? h("div", { class: "empty", text: "No requests yet. Send one from the API docs page." })
              : h("ul", { class: "list" }, d.recent.map(requestRow))),
          h("div", { class: "stack" },
            h("div", { class: "card" }, h("h2", { text: "Daily quota" }),
              h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, bar),
              h("p", { class: "small muted", text: `${d.quota.usedUnits} of ${d.quota.dailyUnits} SMS units reserved today` })),
            h("div", { class: "card" }, h("h2", { text: "Phone" }),
              d.devices.items.length === 0
                ? h("p", { class: "muted", text: "No phone connected yet." })
                : h("ul", { class: "list" }, d.devices.items.map((x) => h("li", { class: "item" },
                    h("span", { class: "t", text: x.nickname }), h("span", { class: "pill " + (x.online ? "ok" : "off"), text: x.online ? "Online" : "Offline" }),
                    h("span", { class: "meta", text: `Last seen ${ago(x.lastSeenAt)}` })))) ),
            h("div", { class: "card" }, h("h2", { text: "Setup checklist" }),
              h("ul", { class: "list" }, todo.map(([ok, label, href]) => h("li", { class: "item" },
                href && !ok ? h("a", { class: "t", href, text: label }) : h("span", { class: "t", text: label }),
                h("span", { class: "pill " + (ok ? "ok" : "off"), text: ok ? "Done" : "To do" })))))))),
    ];
  });
}

const DELETABLE = new Set(["sent", "delivered", "failed", "unknown", "expired", "cancelled", "demo_completed"]);
const TONE = { delivered: "ok", sent: "ok", demo_completed: "off", cancelled: "off", failed: "bad", unknown: "bad", expired: "bad" };

async function deleteOne(id, after) {
  if (!(await ask({ title: "Delete this request?", body: `${id} and its timeline are removed from your list for good. Your message text was never stored here.`, confirm: "Delete", danger: true }))) return;
  try { await api("POST", `/sms/requests/${encodeURIComponent(id)}/delete`); toast("Request deleted"); after(); }
  catch (e) { toast(e.message, true); }
}
function iconBtn(name, label, onclick, cls = "") {
  return h("button", { class: "ibtn " + cls, type: "button", "aria-label": label, title: label, onclick }, icon(name));
}
function requestRow(r, refresh) {
  const open = () => { location.hash = `#/requests/${encodeURIComponent(r.id)}`; };
  const actions = () => sheet(r.id, [
    { label: "Copy request ID", icon: "copy", run: () => copy(r.id, "Request ID copied") },
    { label: "Open details", icon: "open", run: open },
    ...(DELETABLE.has(r.status) ? [{ label: "Delete request", icon: "trash", danger: true, run: () => deleteOne(r.id, refresh) }] : []),
  ], `${r.to} · ${r.mode} · ${ago(r.createdAt)}`);
  const li = h("li", { class: `rcard ${TONE[r.status] || "warn"}` },
    h("div", { class: "rtop" },
      h("a", { class: "rid mono", href: `#/requests/${encodeURIComponent(r.id)}`, text: r.id }),
      statusPill(r.status)),
    h("div", { class: "rmeta" },
      h("span", { class: "tag", text: r.to }), h("span", { class: "tag", text: `${r.units} unit${r.units === 1 ? "" : "s"}` }),
      h("span", { class: "tag " + (r.mode === "live" ? "live" : ""), text: r.mode }), h("span", { class: "tag faint", text: ago(r.createdAt) })),
    h("div", { class: "ract" },
      iconBtn("copy", "Copy request ID", () => copy(r.id, "Request ID copied")),
      iconBtn("more", "More actions", actions),
      DELETABLE.has(r.status) ? iconBtn("trash", "Delete request", () => deleteOne(r.id, refresh), "danger") : null));
  longPress(li, actions);
  return li;
}

/* -------------------------------- Send -------------------------------- */
const SEND_ERRORS = {
  NO_ELIGIBLE_DEVICE: "No phone is online. Open the app on your phone, tap Start connector, then try again.",
  LIVE_SENDING_DISABLED: "Live sending is off for the platform or your account. Use Demo, or ask the administrator.",
  RATE_LIMITED: "Too many requests. Wait a minute and try again.",
  QUOTA_EXCEEDED: "You have used today's SMS limit.",
  RECIPIENT_SUPPRESSED: "This number is on your suppression list.",
};
const unitsOf = (m) => { const asc = /^[\x20-\x7E\r\n]*$/.test(m); const [one, multi] = asc ? [160, 153] : [70, 67]; return m.length <= one ? (m.length ? 1 : 0) : Math.ceil(m.length / multi); };

export function send(root) {
  mount(root, () => api("GET", "/dashboard"), (d) => {
    const liveOk = d.account.liveSendingAllowed;
    const phoneOnline = d.devices.online > 0;
    let mode = "demo", busy = false, idem = crypto.randomUUID();
    const result = h("div");
    const err = h("p", { class: "err", role: "alert" });
    const to = h("input", { id: "s-to", type: "tel", inputmode: "tel", autocomplete: "off", placeholder: "+919876543210" });
    const msg = h("textarea", { id: "s-msg", maxlength: "1600", placeholder: "Your message" });
    const counter = h("p", { class: "small muted counter" });
    const upd = () => { counter.textContent = `${msg.value.length} chars · ${unitsOf(msg.value)} SMS unit${unitsOf(msg.value) === 1 ? "" : "s"}`; };
    msg.addEventListener("input", upd); upd();
    const submit = h("button", { class: "btn primary", type: "submit" });
    const modes = h("div", { class: "modes", role: "radiogroup", "aria-label": "Mode" });
    const paint = () => {
      const opt = (v, title, sub, disabled) => h("label", { class: "mode" + (mode === v ? " sel" : "") + (disabled ? " dis" : "") },
        h("input", { type: "radio", name: "mode", value: v, checked: mode === v, disabled, onchange: () => { mode = v; paint(); } }), h("b", { text: title }), h("span", { class: "small muted", text: sub }));
      clear(modes).append(
        opt("demo", "Demo", "Nothing is sent. Safe for trying the flow.", false),
        opt("live", "Live — real SMS", liveOk ? (phoneOnline ? "Sent from your phone's SIM. Carrier charges apply." : "Your phone is offline — start the connector first.") : "Live sending is off for now.", !liveOk));
      submit.textContent = mode === "live" ? "Send real SMS" : "Send demo";
    };
    paint();

    const form = h("form", { class: "card", novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); if (busy) return;
      const number = to.value.replace(/[\s-]/g, "");
      if (!/^\+[1-9]\d{6,14}$/.test(number)) { err.textContent = "Enter the number with country code, like +919876543210."; return; }
      if (!msg.value.trim()) { err.textContent = "Type a message."; return; }
      if (mode === "live" && !(await ask({ title: "Send a real SMS?", body: `A real message goes to ${number} from your phone's SIM. Your carrier may charge you.`, confirm: "Send SMS", danger: true }))) return;
      busy = true; submit.disabled = true; err.textContent = "";
      try {
        const r = await api("POST", "/dashboard/send", { to: number, message: msg.value, mode, idempotencyKey: idem });
        idem = crypto.randomUUID();
        track(r.id, mode);
        msg.value = ""; upd();
      } catch (er) { err.textContent = SEND_ERRORS[er.code] || er.message; }
      finally { busy = false; submit.disabled = false; }
    } },
      h("div", { class: "field" }, h("label", { for: "s-to", text: "To (with country code)" }), to),
      h("div", { class: "field" }, h("label", { for: "s-msg", text: "Message" }), msg, counter),
      modes, err, h("div", { class: "row" }, submit));

    // Shows the request and follows it until it finishes (up to about 2 minutes).
    function track(id, m) {
      const pill = h("span"); const note = h("p", { class: "small muted" });
      clear(result).append(h("div", { class: "card" }, h("h2", { text: m === "live" ? "Request created" : "Demo recorded" }),
        h("p", { class: "mono", text: id }), h("div", { class: "row" }, pill, h("a", { href: `#/requests/${encodeURIComponent(id)}`, text: "Open details" })), note));
      if (m === "demo") { clear(pill).append(statusPill("demo_completed")); note.textContent = "Nothing was sent."; return; }
      let tries = 0;
      const poll = async () => {
        if (!document.body.contains(pill)) return;
        try {
          const { request: r } = await api("GET", `/sms/requests/${encodeURIComponent(id)}`);
          clear(pill).append(statusPill(r.status));
          note.textContent = r.status === "sent" ? "Handed to the mobile network. Delivery is confirmed only if the carrier reports it."
            : r.status === "delivered" ? "The carrier confirmed delivery."
            : r.status === "queued" ? "Waiting for your phone to pick it up…" : "";
          if (["delivered", "failed", "expired", "unknown", "cancelled"].includes(r.status)) return;
        } catch { /* keep trying */ }
        if (++tries < 40) setTimeout(poll, 3000);
      };
      poll();
    }

    return [head("Send SMS", "Send a message from this dashboard — no API key or terminal needed."),
      h("div", { class: "stack" },
        mode === "demo" && !liveOk ? h("div", { class: "banner warn" }, h("div", {}, h("b", { text: "Live sending is off" }), "Only Demo works right now. The administrator controls the live switch.")) : null,
        form, result)];
  });
}

/* ------------------------------ Requests ------------------------------ */
const FILTERS = [["", "All"], ["pending", "Pending"], ["sent", "Sent"], ["delivered", "Delivered"], ["failed", "Failed"], ["expired", "Expired"], ["demo_completed", "Demo"]];

export function requests(root) {
  let filter = "";
  const list = h("div");
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter by status" });
  const paint = () => {
    clear(chips).append(...FILTERS.map(([v, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(filter === v), text: label, onclick: () => { filter = v; paint(); fetchList(); } })));
  };
  const fetchList = () => mount(list, () => api("GET", "/sms/requests" + (filter ? `?status=${filter}` : "")), (d) =>
    h("div", { class: "rwrap" }, d.requests.length === 0
      ? h("div", { class: "empty", text: "Nothing here." })
      : h("ul", { class: "rlist" }, d.requests.map((r) => requestRow(r, fetchList))),
      h("p", { class: "small muted hint-line", text: `Showing matches from your latest ${d.scanned} requests. Long-press a card for actions. Message text is never shown here.` }),
      (() => { const done = d.requests.filter((r) => DELETABLE.has(r.status)); return done.length > 1 ? h("button", { class: "btn small danger", type: "button", text: `Delete ${done.length} finished`, onclick: async () => {
        if (!(await ask({ title: `Delete ${done.length} finished requests?`, body: "Only requests that already finished are removed. Anything still in progress stays.", confirm: "Delete all", danger: true }))) return;
        let n = 0; try { for (const r of done) { await api("POST", `/sms/requests/${encodeURIComponent(r.id)}/delete`); n++; } toast(`${n} deleted`); } catch (e) { toast(e.message, true); }
        fetchList();
      } }) : null; })()));
  clear(root).append(head("Requests", "Every SMS your API keys submitted.", h("button", { class: "btn", type: "button", onclick: fetchList, text: "Refresh" })), chips, list);
  paint(); fetchList();
}

export function requestDetail(root, id) {
  mount(root, () => api("GET", `/sms/requests/${encodeURIComponent(id)}`), ({ request: r, timeline }) => [
    head("Request", null, h("a", { class: "btn", href: "#/requests", text: "← All requests" })),
    h("div", { class: "stack" },
      h("div", { class: "card" },
        h("div", { class: "row" }, h("h2", { class: "mono rid-big", text: r.id }), statusPill(r.status)),
        h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => copy(r.id, "Request ID copied") }, icon("copy"), " Copy ID"),
          DELETABLE.has(r.status) ? h("button", { class: "btn small danger", type: "button", onclick: () => deleteOne(r.id, () => { location.hash = "#/requests"; }) }, icon("trash"), " Delete") : null),
        r.status === "unknown" ? h("div", { class: "note warn", text: "The phone could not confirm whether this was sent. CWP never retries it automatically, to avoid texting someone twice." }) : null,
        r.deliveryConfirmed ? null : h("p", { class: "small muted", text: "“Sent” means the phone handed the message to the network. Only “Delivered” is confirmed by the carrier." }),
        h("dl", { class: "kv" },
          ...[["To", r.to], ["Mode", r.mode], ["Length", `${r.messageChars} chars · ${r.units} unit(s)`], ["Reference", r.clientReference || "—"],
              ["Created", when(r.createdAt)], ["Sent", when(r.sentAt)], ["Delivered", when(r.deliveredAt)], ["Expires", when(r.expiresAt)],
              ["Attempts", r.attempts], ["Error", r.errorCode ? `${r.errorCode}${r.errorMessage ? " — " + r.errorMessage : ""}` : "—"]]
            .flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })]))),
      h("div", { class: "card" }, h("h2", { text: "Timeline" }),
        timeline.length === 0 ? h("p", { class: "muted", text: "No transitions recorded." })
          : h("ol", { class: "timeline" }, timeline.map((e) => h("li", {}, h("b", { text: `${e.from} → ${e.to}` }), h("div", { class: "small muted", text: `${e.source} · ${when(e.at)}` })))))),
  ]);
}

/* -------------------------------- Keys -------------------------------- */
export function keys(root) {
  const secretSlot = h("div");
  const listSlot = h("div");
  const err = h("p", { class: "err", role: "alert" });
  let busy = false;

  const form = h("form", { class: "card", novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const name = form.elements.name.value.trim(), kind = form.elements.kind.value, env = form.elements.env.value;
    if (!name) { err.textContent = "Give the key a name."; return; }
    busy = true; err.textContent = "";
    try {
      const body = kind === "connector" ? { name, environment: "live", scopes: ["connector"] } : { name, environment: env };
      const k = await api("POST", "/keys", body);
      if (k.kind === "connector") { state.lastConnectorSecret = k.secret; state.lastConnectorKeyId = k.keyId; }
      clear(secretSlot).append(secretPanel(k));
      form.reset(); syncEnv(); loadList();
    } catch (e) { err.textContent = e.message; }
    finally { busy = false; }
  } },
    h("h2", { text: "Create a key" }),
    h("div", { class: "formgrid" },
      h("div", { class: "field" }, h("label", { for: "k-name", text: "Name" }), h("input", { id: "k-name", name: "name", maxlength: "60", placeholder: "e.g. My Pixel phone", autocomplete: "off" })),
      h("div", { class: "field" }, h("label", { for: "k-kind", text: "Used for" }),
        h("select", { id: "k-kind", name: "kind", onchange: () => syncEnv() },
          h("option", { value: "connector", text: "Android app (connector key)" }), h("option", { value: "api", text: "My server (SMS API key)" }))),
      h("div", { class: "field", id: "env-field" }, h("label", { for: "k-env", text: "Environment" }),
        h("select", { id: "k-env", name: "env" }, h("option", { value: "test", text: "test — demo only" }), h("option", { value: "live", text: "live — real SMS" })))),
    h("p", { class: "small muted", text: "A connector key only enrolls your phone. It cannot send SMS or read your dashboard. An SMS API key sends messages but cannot enroll a phone." }),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Create key" })), err);
  const syncEnv = () => { form.querySelector("#env-field").hidden = form.elements.kind.value === "connector"; };
  syncEnv();

  function loadList() {
    mount(listSlot, () => api("GET", "/keys"), ({ keys: ks }) => {
      const group = (title, items, empty) => {
        const dead = items.filter((k) => k.status !== "active");
        return h("div", { class: "card" },
          h("div", { class: "row" }, h("h2", { text: title }), h("span", { class: "spacer" }),
            dead.length > 1 ? h("button", { class: "btn small danger", type: "button", text: `Delete ${dead.length} revoked`, onclick: () => purge(dead) }) : null),
          items.length === 0 ? h("p", { class: "muted", text: empty }) : h("ul", { class: "list" }, items.map(keyRow)));
      };
      return h("div", { class: "stack" },
        group("Connector keys (Android app)", ks.filter((k) => k.kind === "connector"), "No connector key yet."),
        group("SMS API keys (your server)", ks.filter((k) => k.kind !== "connector"), "No API key yet."));
    });
  }
  async function purge(list) {
    if (!(await ask({ title: `Delete ${list.length} revoked keys?`, body: "They are already switched off. This removes them from your list for good.", confirm: "Delete all", danger: true }))) return;
    try { for (const k of list) await api("POST", `/keys/${k.keyId}/delete`); toast("Revoked keys deleted"); } catch (e) { toast(e.message, true); }
    loadList();
  }
  function keyRow(k) {
    const active = k.status === "active";
    return h("li", { class: "item" },
      h("span", { class: "t", text: k.name }),
      h("span", { class: "end" }, h("span", { class: "pill " + (active ? "ok" : "off"), text: k.status }),
        active ? h("button", { class: "btn small danger", type: "button", text: "Revoke", onclick: async (ev) => {
          if (!(await ask({ title: `Revoke “${k.name}”?`, body: "Anything using this key stops working immediately.", confirm: "Revoke", danger: true }))) return;
          ev.target.disabled = true;
          try { await api("DELETE", `/keys/${k.keyId}`); toast("Key revoked"); loadList(); }
          catch (e) { toast(e.message, true); ev.target.disabled = false; }
        } }) : h("button", { class: "btn small danger", type: "button", text: "Delete", onclick: async (ev) => {
          if (!(await ask({ title: `Delete “${k.name}”?`, body: "It is already revoked. Deleting removes it from your list for good.", confirm: "Delete", danger: true }))) return;
          ev.target.disabled = true;
          try { await api("POST", `/keys/${k.keyId}/delete`); toast("Key deleted"); loadList(); }
          catch (e) { toast(e.message, true); ev.target.disabled = false; }
        } })),
      h("span", { class: "meta mono", text: `${k.prefix}… · ${k.environment} · created ${ago(k.createdAt)}${k.revokedAt ? " · revoked " + ago(k.revokedAt) : ""}` }));
  }

  clear(root).append(head("API keys", "Create and revoke keys. A secret is shown once, at creation."), h("div", { class: "stack" }, form, secretSlot, listSlot));
  loadList();
}

function secretPanel(k) {
  const isConn = k.kind === "connector";
  const gradle = `android {\n    defaultConfig {\n        manifestPlaceholders["cwpBaseUrl"] = "${BASE()}"\n        manifestPlaceholders["cwpApiKey"]  = "${k.secret}"\n    }\n}`;
  return h("div", { class: "secret" },
    h("b", { text: "Copy this key now — it will not be shown again." }),
    h("code", { text: k.secret }),
    h("div", { class: "row" }, h("button", { class: "btn small", type: "button", text: "Copy key", onclick: () => copy(k.secret, "Key copied") })),
    isConn ? h("div", {}, h("p", { class: "small", text: "Paste this into your Android app's build.gradle (Kotlin DSL shown):" }), codeBlock(gradle), h("p", { class: "small" }, h("a", { class: "btn small", href: "#/sdk", text: "Open the Android SDK guide" }))) : null);
}

/* ------------------------------ Devices ------------------------------ */
export function devices(root) {
  mount(root, () => api("GET", "/devices"), ({ devices: ds }) => {
    const act = ds.filter((d) => d.status === "active"), old = ds.filter((d) => d.status !== "active");
    return [head("Devices", "Phones that send your SMS through their SIM.", h("button", { class: "btn", type: "button", onclick: () => devices(root), text: "Refresh" })),
      h("div", { class: "stack" },
        h("div", { class: "card" },
          act.length === 0 ? h("div", { class: "empty" }, "No phone connected. ", h("a", { class: "btn small primary", href: "#/sdk", text: "Set up the Android SDK" }))
            : h("ul", { class: "list" }, act.map((d) => h("li", { class: "item" },
                h("span", { class: "t", text: d.nickname }),
                h("span", { class: "end" }, h("span", { class: "pill " + (d.online ? "ok" : "off"), text: d.online ? "Online" : "Offline" }),
                  h("button", { class: "btn small danger", type: "button", text: "Remove", onclick: async (ev) => {
                    if (!(await ask({ title: `Remove “${d.nickname}”?`, body: "It stops receiving messages straight away.", confirm: "Remove", danger: true }))) return;
                    ev.target.disabled = true;
                    try { await api("POST", `/devices/${d.deviceId}/revoke`); toast("Device removed"); devices(root); }
                    catch (e) { toast(e.message, true); ev.target.disabled = false; }
                  } })),
                h("span", { class: "meta", text: `App ${d.appVersion} · SMS permission ${d.smsPermissionGranted ? "granted" : "missing"} · SIM ${d.telephonyAvailable ? (d.simDisplayLabel || "ready") : "unavailable"} · connector ${d.connectorRunning ? "running" : "stopped"} · seen ${ago(d.lastSeenAt)}` }))))),
        old.length ? h("div", { class: "card" },
          h("div", { class: "row" }, h("h2", { text: "Removed phones" }), h("span", { class: "spacer" }),
            old.length > 1 ? h("button", { class: "btn small danger", type: "button", text: `Delete ${old.length} removed`, onclick: async () => {
              if (!(await ask({ title: `Delete ${old.length} removed phones?`, body: "They are already switched off. This clears them from your list for good.", confirm: "Delete all", danger: true }))) return;
              try { for (const d of old) await api("POST", `/devices/${d.deviceId}/delete`); toast("Removed phones deleted"); } catch (e) { toast(e.message, true); }
              devices(root);
            } }) : null),
          h("ul", { class: "list" }, old.map((d) => h("li", { class: "item" }, h("span", { class: "t", text: d.nickname }),
            h("span", { class: "end" }, h("span", { class: "pill off", text: "removed" }),
              h("button", { class: "btn small danger", type: "button", text: "Delete", onclick: async (ev) => {
                if (!(await ask({ title: `Delete “${d.nickname}”?`, body: "It is already removed. Deleting clears it from your list for good.", confirm: "Delete", danger: true }))) return;
                ev.target.disabled = true;
                try { await api("POST", `/devices/${d.deviceId}/delete`); toast("Phone deleted"); devices(root); }
                catch (e) { toast(e.message, true); ev.target.disabled = false; }
              } })))))) : null)];
  });
}

/* -------------------------------- Docs -------------------------------- */
export function docs(root) {
  const b = BASE();
  const send = `curl -X POST ${b}/api/v1/sms/send \\\n  -H "Authorization: Bearer $CWP_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: order-1001" \\\n  -d '{"to":"+919876543210","message":"Your code is 482913","mode":"live"}'`;
  const status = `curl ${b}/api/v1/sms/status/<id> \\\n  -H "Authorization: Bearer $CWP_API_KEY"`;
  clear(root).append(head("API docs", "Send SMS from your own server."), h("div", { class: "stack" },
    h("div", { class: "card" }, h("h2", { text: "Send" }), codeBlock(send),
      h("p", { class: "small muted", text: "202 means recorded — not sent, not delivered. Use a unique Idempotency-Key per message so retries never double-send. Use mode “demo” (or a test key) to try without a phone." })),
    h("div", { class: "card" }, h("h2", { text: "Check status" }), codeBlock(status),
      h("p", { class: "small muted", text: "deliveryConfirmed is true only for “delivered”. queued, sent and unknown are never reported as delivered." })),
    h("div", { class: "card" }, h("h2", { text: "Statuses" }),
      h("ul", { class: "list" }, ["queued", "assigned", "sending", "sent", "delivery_pending", "delivered", "failed", "unknown", "expired", "demo_completed"].map((s) => h("li", { class: "item" }, statusPill(s), h("span", { class: "meta", text: STATUS_HELP[s] })))))));
}
const STATUS_HELP = {
  queued: "Waiting for your phone to pick it up (expires after 5 minutes).",
  assigned: "A phone has leased the job and is about to send.",
  sending: "The phone is sending. If this is lost, the job becomes “unknown” and is never retried.",
  sent: "Handed to the mobile network. Not yet confirmed delivered.",
  delivery_pending: "Waiting for the carrier's delivery report.",
  delivered: "The carrier confirmed delivery.",
  failed: "The phone or carrier reported a failure. Quota is returned.",
  unknown: "Outcome could not be confirmed. Never retried automatically.",
  expired: "No phone picked it up within 5 minutes, so it failed. Quota is returned.",
  demo_completed: "A demo request: nothing was sent.",
};
export { ApiFail };

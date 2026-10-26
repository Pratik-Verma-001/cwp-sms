import { api, ago, ask, clear, countUp, h, icon, liquidNav, logoMark, session, splash, statusPill, themeButton, toast, when } from "./core.js";
import { startAuth } from "./authui.js";

const app = document.getElementById("app");
const brand = () => h("div", { class: "brand" }, h("span", { class: "brand-mark" }, logoMark()), "CWP SMS ", h("span", { class: "pill off", text: "Admin" }));

const head = (title, sub, ...actions) =>
  h("div", { class: "page-head" }, h("div", {}, h("h1", { text: title }), sub ? h("p", { text: sub }) : null), h("div", { class: "row" }, ...actions));

async function mount(root, load, view) {
  const gen = (root._gen = (root._gen || 0) + 1);
  const t = setTimeout(() => { if (root._gen === gen) clear(root).append(splash("Loading…", true)); }, 140);
  try { const d = await load(); clearTimeout(t); if (root._gen !== gen) return; clear(root).append(...[].concat(view(d))); }
  catch (e) {
    clearTimeout(t);
    if (root._gen !== gen) return;
    clear(root).append(h("div", { class: "banner bad" }, h("div", {}, h("b", { text: "Could not load" }), e.message || "Unexpected error.", " ",
      h("button", { class: "btn small", type: "button", text: "Try again", onclick: () => mount(root, load, view) }))));
  }
}

const stat = (label, num, hint) => { const n = h("div", { class: "num" }); countUp(n, num); return h("div", { class: "stat" }, h("div", { class: "label", text: label }), n, hint ? h("div", { class: "hint", text: hint }) : null); };
const onoff = (v, yes = "ON", no = "OFF") => h("span", { class: "pill " + (v ? "ok" : "off"), text: v ? yes : no });

/* ---------------- Overview + platform switch ---------------- */
function overview(root) {
  mount(root, () => api("GET", "/admin/overview"), (d) => {
    const p = d.platform, t = d.totals;
    const set = async (value, label) => {
      if (!(await ask({ title: "Change the platform switch?", body: label, confirm: "Yes, change", danger: value === false }))) return;
      try { await api("POST", "/admin/platform", { liveSendingEnabled: value }); toast("Saved. Applies within ~15 seconds."); overview(root); }
      catch (e) { toast(e.message, true); }
    };
    return [head("Overview", `Signed in as ${d.adminEmail}`, h("button", { class: "btn", type: "button", text: "Refresh", onclick: () => overview(root) })),
      h("div", { class: "stack" },
        h("div", { class: "card" },
          h("div", { class: "row" }, h("h2", { text: "Live sending (whole platform)" }), h("span", { class: "spacer" }), onoff(p.effective)),
          h("p", { class: "muted", text: p.effective
            ? "Phones may send real SMS for accounts that have live sending enabled."
            : "No real SMS can be sent by anyone. Demo requests still work." }),
          h("p", { class: "small muted", text: `Environment default: ${p.envDefault ? "ON" : "OFF"} · Admin override: ${p.override === null ? "none" : p.override ? "ON" : "OFF"}` }),
          h("div", { class: "row" },
            h("button", { class: "btn primary", type: "button", disabled: p.effective && p.override === true, text: "Turn ON", onclick: () => set(true, "Turn live sending ON for the whole platform?") }),
            h("button", { class: "btn danger", type: "button", disabled: !p.effective && p.override === false, text: "Turn OFF", onclick: () => set(false, "Turn live sending OFF for everyone, immediately?") }),
            h("button", { class: "btn", type: "button", disabled: p.override === null, text: "Reset to default", onclick: () => set(null, "Remove the override and use the environment default?") }))),
        h("div", { class: "grid stats" },
          stat("Users", t.users, `${t.suspendedUsers} suspended`), stat("Live-enabled users", t.liveEnabledUsers),
          stat("Phones online", t.onlineDevices, `of ${t.activeDevices} active`), stat("Active keys", t.activeApiKeys + t.activeConnectorKeys, `${t.activeApiKeys} API · ${t.activeConnectorKeys} connector`)),
        d.truncated ? h("p", { class: "small muted", text: "Counts are limited to the newest 500 records." }) : null)];
  });
}

/* ---------------- Users ---------------- */
function users(root) {
  mount(root, () => api("GET", "/admin/users"), ({ users: list }) => {
    const box = h("ul", { class: "ugrid" });
    const filter = h("input", { type: "search", placeholder: "Search email or user id", "aria-label": "Search users", autocomplete: "off" });
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const rows = list.filter((u) => !q || (u.email || "").toLowerCase().includes(q) || u.uid.toLowerCase().includes(q));
      clear(box).append(...(rows.length ? rows.map(userRow) : [h("li", { class: "empty ugrid-empty", text: "No users match." })]));
    };
    filter.addEventListener("input", paint); paint();
    return [head("Users", `${list.length} account${list.length === 1 ? "" : "s"}`), h("div", { class: "card" }, h("div", { class: "field" }, filter), box)];
  });
}
function userRow(u) {
  const name = u.email || u.uid;
  return h("li", { class: "ucard" },
    h("span", { class: "avatar", "aria-hidden": "true", text: name.charAt(0).toUpperCase() }),
    h("div", { class: "ubody" },
      h("a", { class: "uname", href: `#/users/${encodeURIComponent(u.uid)}`, text: name }),
      h("div", { class: "rmeta" },
        h("span", { class: "tag", text: `${u.activeKeys} key${u.activeKeys === 1 ? "" : "s"}` }), h("span", { class: "tag", text: `${u.onlineDevices}/${u.devices} phone online` }),
        h("span", { class: "tag faint", text: `login ${ago(u.lastLoginAt)}` }))),
    h("span", { class: "end" }, u.status !== "active" ? h("span", { class: "pill bad", text: u.status }) : null, h("span", { class: "pill " + (u.liveSendingEnabled ? "ok" : "off"), text: u.liveSendingEnabled ? "Live" : "Demo only" })));
}

/* ---------------- One user ---------------- */
const LIMITS = [["dailyUnits", "SMS units per day"], ["requestsPerMinute", "Requests per minute"], ["maxDevices", "Connected phones"], ["maxActiveKeys", "Active keys"]];

function userDetail(root, uid) {
  mount(root, () => api("GET", `/admin/users/${encodeURIComponent(uid)}`), (d) => {
    const u = d.user;
    const patch = async (body, ok = "Saved") => {
      try { await api("POST", `/admin/users/${encodeURIComponent(uid)}`, body); toast(ok); userDetail(root, uid); }
      catch (e) { toast(e.message, true); }
    };
    const inputs = LIMITS.map(([k, label]) => {
      const el = h("input", { id: `l-${k}`, type: "number", min: "1", inputmode: "numeric", placeholder: `default ${u.effectiveLimits[k]}`, value: u.limitOverrides[k] ?? "" });
      return { k, label, el };
    });
    const saveLimits = (e) => {
      e.preventDefault();
      const limits = {};
      for (const { k, el } of inputs) { const v = el.value.trim(); limits[k] = v === "" ? null : Number(v); if (v !== "" && !(Number.isInteger(limits[k]) && limits[k] > 0)) return toast("Limits must be whole numbers above 0.", true); }
      patch({ limits }, "Limits saved");
    };
    const pct = Math.min(100, Math.round((d.usage.usedUnits / d.usage.dailyUnits) * 100));
    const bar = h("i"); bar.style.width = pct + "%";

    return [head(u.email || u.uid, null, h("a", { class: "btn", href: "#/users", text: "← Users" })),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("dl", { class: "kv" },
          ...[["User id", u.uid], ["Created", when(u.createdAt)], ["Last login", when(u.lastLoginAt)], ["Status", u.status]].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { class: k === "User id" ? "mono" : "", text: v })]))),
        h("div", { class: "card" }, h("h2", { text: "Controls" }),
          h("ul", { class: "list" },
            ctl("Live sending", "Allows real SMS for this account (platform switch must also be on).", u.liveSendingEnabled, u.liveSendingEnabled ? "Turn OFF" : "Turn ON", () => patch({ liveSendingEnabled: !u.liveSendingEnabled })),
            ctl("Demo mode", "Lets the account send demo (simulated) requests.", u.demoModeEnabled, u.demoModeEnabled ? "Turn OFF" : "Turn ON", () => patch({ demoModeEnabled: !u.demoModeEnabled })),
            ctl("Account", u.status === "active" ? "Active. Suspending stops the dashboard, API keys and phone at once." : "Suspended. Nothing works for this account.", u.status === "active", u.status === "active" ? "Suspend" : "Re-activate",
              async () => { if (u.status !== "active" || (await ask({ title: `Suspend ${u.email || uid}?`, body: "Their keys and phone stop working immediately.", confirm: "Suspend", danger: true }))) patch({ status: u.status === "active" ? "suspended" : "active" }); }, "Active", "Suspended"))),
        h("form", { class: "card", onsubmit: saveLimits, novalidate: true }, h("h2", { text: "Limits" }),
          h("p", { class: "small muted", text: "Leave a box empty to use the platform default." }),
          h("div", { class: "formgrid" }, inputs.map(({ k, label, el }) => h("div", { class: "field" }, h("label", { for: `l-${k}`, text: label }), el))),
          h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit", text: "Save limits" }))),
        h("div", { class: "card" }, h("h2", { text: "Usage today" }),
          h("div", { class: "bar" }, bar), h("p", { class: "small muted", text: `${d.usage.usedUnits} of ${d.usage.dailyUnits} SMS units reserved · ${d.counts.window} recent requests` }),
          h("p", { class: "small muted", text: Object.entries(d.counts.byStatus).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No requests yet." })),
        h("div", { class: "card" }, h("h2", { text: "API & connector keys" }),
          d.keys.length === 0 ? h("p", { class: "muted", text: "None." }) : h("ul", { class: "list" }, d.keys.map((k) => h("li", { class: "item" },
            h("span", { class: "t", text: `${k.name} · ${k.kind === "connector" ? "connector" : "SMS API"}` }),
            h("span", { class: "end" }, h("span", { class: "pill " + (k.status === "active" ? "ok" : "off"), text: k.status }),
              k.status === "active" ? h("button", { class: "btn small danger", type: "button", text: "Revoke", onclick: async () => {
                if (!(await ask({ title: `Revoke "${k.name}"?`, body: "Anything using it stops immediately.", confirm: "Revoke", danger: true }))) return;
                try { await api("POST", `/admin/users/${encodeURIComponent(uid)}/keys/${k.keyId}/revoke`); toast("Key revoked"); userDetail(root, uid); } catch (e) { toast(e.message, true); } } }
              ) : h("button", { class: "btn small danger", type: "button", text: "Delete", onclick: async () => {
                if (!(await ask({ title: `Delete "${k.name}"?`, body: "Already revoked. This removes it for good.", confirm: "Delete", danger: true }))) return;
                try { await api("POST", `/admin/users/${encodeURIComponent(uid)}/keys/${k.keyId}/delete`); toast("Key deleted"); userDetail(root, uid); } catch (e) { toast(e.message, true); } } })),
            h("span", { class: "meta mono", text: `${k.prefix}… · ${k.environment} · created ${ago(k.createdAt)} · last used ${ago(k.lastUsedAt)}` }))))),
        h("div", { class: "card" }, h("h2", { text: "Phones" }),
          d.devices.length === 0 ? h("p", { class: "muted", text: "None." }) : h("ul", { class: "list" }, d.devices.map((x) => h("li", { class: "item" },
            h("span", { class: "t", text: x.nickname }),
            h("span", { class: "end" }, h("span", { class: "pill " + (x.status !== "active" ? "off" : x.online ? "ok" : "warn"), text: x.status !== "active" ? "removed" : x.online ? "Online" : "Offline" }),
              x.status === "active" ? h("button", { class: "btn small danger", type: "button", text: "Remove", onclick: async () => {
                if (!(await ask({ title: `Remove phone "${x.nickname}"?`, body: "It stops receiving messages immediately.", confirm: "Remove", danger: true }))) return;
                try { await api("POST", `/admin/users/${encodeURIComponent(uid)}/devices/${x.deviceId}/revoke`); toast("Phone removed"); userDetail(root, uid); } catch (e) { toast(e.message, true); } } }
              ) : h("button", { class: "btn small danger", type: "button", text: "Delete", onclick: async () => {
                if (!(await ask({ title: `Delete phone "${x.nickname}"?`, body: "Already removed. This clears it for good.", confirm: "Delete", danger: true }))) return;
                try { await api("POST", `/admin/users/${encodeURIComponent(uid)}/devices/${x.deviceId}/delete`); toast("Phone deleted"); userDetail(root, uid); } catch (e) { toast(e.message, true); } } })),
            h("span", { class: "meta", text: `App ${x.appVersion} · SMS permission ${x.smsPermissionGranted ? "yes" : "no"} · SIM ${x.telephonyAvailable ? "ready" : "unavailable"} · seen ${ago(x.lastSeenAt)}` }))))),
        h("div", { class: "card" }, h("h2", { text: "Recent requests" }),
          d.recent.length === 0 ? h("p", { class: "muted", text: "None." }) : h("ul", { class: "list" }, d.recent.map((r) => h("li", { class: "item" },
            h("span", { class: "t mono", text: r.id }), statusPill(r.status),
            h("span", { class: "meta", text: `${r.to} · ${r.units} unit${r.units === 1 ? "" : "s"} · ${r.mode} · ${ago(r.createdAt)}${r.errorCode ? " · " + r.errorCode : ""}` })))),
          h("p", { class: "small muted", text: "Message text is never shown, and numbers are masked." })))];
  });
}
function ctl(title, sub, on, actionLabel, onclick, yes, no) {
  return h("li", { class: "item" }, h("span", { class: "t", text: title }),
    h("span", { class: "end" }, onoff(on, yes, no), h("button", { class: "btn small", type: "button", text: actionLabel, onclick })),
    h("span", { class: "meta", text: sub }));
}

/* ---------------- Audit ---------------- */
function auditPage(root) {
  mount(root, () => api("GET", "/admin/audit"), ({ entries }) => [
    head("Audit log", "Every admin change, newest first."),
    h("div", { class: "card" }, entries.length === 0 ? h("div", { class: "empty", text: "No admin actions yet." })
      : h("ul", { class: "list" }, entries.map((e) => h("li", { class: "item" }, h("span", { class: "t", text: e.action }), h("span", { class: "small muted", text: ago(e.at) }),
          h("span", { class: "meta", text: `${e.admin || "admin"}${e.targetUid ? " → " + e.targetUid : ""}${e.detail ? " · " + e.detail : ""}` })))))]);
}

/* ---------------- shell ---------------- */
function shell({ signOut }) {
  const main = h("main", { tabindex: "-1" });
  const nav = h("nav", { class: "nav admin-nav", "aria-label": "Admin" },
    ...[["overview", "Overview", "pulse"], ["users", "Users", "users"], ["audit", "Audit", "shield"]].map(([n, l, ic]) => h("a", { href: `#/${n}`, dataset: { n } }, icon(ic), h("span", { text: l }))));
  clear(app).append(h("div", { class: "shell" },
    h("header", { class: "top" }, brand(), h("span", { class: "spacer" }), h("span", { class: "who", text: session.email || "" }), themeButton(), h("button", { class: "btn small", type: "button", text: "Sign out", onclick: signOut })),
    nav, main));
  const route = () => {
    const [name = "overview", arg] = location.hash.replace(/^#\/?/, "").split("/");
    const key = ["overview", "users", "audit"].includes(name) ? name : "overview";
    for (const a of nav.querySelectorAll("a")) { if (a.dataset.n === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
    liquidNav(nav);
    main._gen = (main._gen || 0) + 1;
    if (key === "users" && arg) userDetail(main, decodeURIComponent(arg)); else ({ overview, users, audit: auditPage }[key])(main);
    window.scrollTo(0, 0);
  };
  // Verify admin rights once; anyone else sees a plain refusal and no controls.
  api("GET", "/admin/overview").then(() => { window.onhashchange = route; route(); }).catch((e) => {
    clear(app).append(h("div", { class: "auth" }, brand(), h("h1", { text: "No access" }),
      h("div", { class: "banner bad" }, h("div", {}, h("b", { text: e.code === "NOT_ADMIN" ? "This account is not an administrator." : "Could not open the admin panel." }), e.code === "NOT_ADMIN" ? `${session.email || "This email"} is not on the admin list.` : e.message)),
      h("p", {}, h("button", { class: "btn", type: "button", text: "Sign out", onclick: signOut }))));
  });
}

startAuth({ root: app, title: "Admin panel", subtitle: "Sign in with an administrator account.", brand, onReady: shell });

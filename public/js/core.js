// Tiny DOM helper: children are always text nodes or elements, never HTML strings (no XSS from API data).
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Taps and long-presses on controls must never show a selection box, a download prompt or a drag ghost.
if (typeof document !== "undefined") {
  const CONTROL = "a, button, nav, .btn, .chip, .ibtn, .rcard, .ucard, .sheet, .modal, .tabs, svg";
  document.addEventListener("contextmenu", (e) => { if (e.target.closest?.(CONTROL) && !e.target.closest("input, textarea, pre, code")) e.preventDefault(); });
  document.addEventListener("dragstart", (e) => { if (e.target.closest?.("a, button, svg, img")) e.preventDefault(); });
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(msg, bad = false) {
  const box = document.getElementById("toasts");
  const t = h("div", { class: "toast" + (bad ? " bad" : ""), text: msg });
  box.append(t);
  setTimeout(() => t.remove(), 3800);
}

export async function copy(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { toast("Copy failed — select the text and copy manually.", true); }
}

export function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

/* ---------- session (Firebase Auth REST; tokens live only in this tab) ---------- */
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

export const session = { idToken: null, refreshToken: null, email: null, expiresAt: 0, apiKey: null };
const IDP = "https://identitytoolkit.googleapis.com/v1/accounts";

function friendly(code) {
  const c = String(code || "").split(" ")[0];
  return ({
    EMAIL_EXISTS: "This email already has an account. Sign in instead.",
    EMAIL_NOT_FOUND: "Email or password is wrong.",
    INVALID_PASSWORD: "Email or password is wrong.",
    INVALID_LOGIN_CREDENTIALS: "Email or password is wrong.",
    INVALID_EMAIL: "That email address does not look right.",
    WEAK_PASSWORD: "Password must be at least 6 characters.",
    USER_DISABLED: "This account is disabled.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a few minutes and try again.",
    OPERATION_NOT_ALLOWED: "Email/password sign-in is not enabled in Firebase.",
  })[c] || "Something went wrong. Please try again.";
}

async function idp(path, body) {
  const r = await fetch(`${IDP}:${path}?key=${encodeURIComponent(session.apiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(friendly(j?.error?.message));
  return j;
}

function adopt(j) {
  session.idToken = j.idToken;
  session.refreshToken = j.refreshToken;
  session.email = j.email || session.email;
  session.expiresAt = Date.now() + (Number(j.expiresIn) || 3600) * 1000 - 60_000;
  store.set("cwp.refresh", j.refreshToken);
  if (session.email) store.set("cwp.email", session.email);
}

export const auth = {
  async signIn(email, password) { adopt(await idp("signInWithPassword", { email, password, returnSecureToken: true })); },
  async signUp(email, password) {
    adopt(await idp("signUp", { email, password, returnSecureToken: true }));
    await auth.sendVerification();
  },
  sendVerification() { return idp("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: session.idToken }); },
  resetPassword(email) { return idp("sendOobCode", { requestType: "PASSWORD_RESET", email }); },
  async isVerified() {
    const j = await idp("lookup", { idToken: session.idToken });
    return j.users?.[0]?.emailVerified === true;
  },
  async refresh() {
    const rt = session.refreshToken || store.get("cwp.refresh");
    if (!rt) return false;
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(session.apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    session.email = session.email || store.get("cwp.email");
    adopt({ idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: j.expires_in });
    return true;
  },
  signOut() { session.idToken = session.refreshToken = null; store.del("cwp.refresh"); store.del("cwp.email"); },
};

export class ApiFail extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Calls the CWP API with the Firebase ID token; refreshes it once when it has expired. */
const getCache = new Map(); // path -> { at, promise }: rapid tab taps reuse one request instead of piling up
export function api(method, path, body) {
  if (method !== "GET") { getCache.clear(); return apiCall(method, path, body); }
  const hit = getCache.get(path);
  if (hit && Date.now() - hit.at < 1500) return hit.promise;
  const promise = apiCall(method, path, body);
  getCache.set(path, { at: Date.now(), promise });
  promise.catch(() => getCache.delete(path));
  return promise;
}
async function apiCall(method, path, body) {
  if (Date.now() > session.expiresAt) await auth.refresh();
  const go = () => fetch(`/api/v1${path}`, {
    method,
    headers: { ...(session.idToken ? { Authorization: `Bearer ${session.idToken}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await go();
  if (r.status === 401 && (await auth.refresh())) r = await go();
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFail(r.status, j?.error?.code || "ERROR", j?.error?.message || "Request failed.");
  return j;
}

export function restoreSession() {
  session.refreshToken = store.get("cwp.refresh");
  session.email = store.get("cwp.email");
  return Boolean(session.refreshToken);
}


/* ---------- brand, splash loader, confirm dialog, count-up ---------- */
const NS = "http://www.w3.org/2000/svg";
const BUBBLE = "M20 14L38 14L48 24L48 42Q48 46 44 46L30 46L22 53L22 46L20 46Q16 46 16 42L16 18Q16 14 20 14Z";
/** The CWP mark. Every theme has its own logo; see theme-init.js. */
export function logoMark(cls = "") { return window.CWPTheme.logoNode(cls); }

/* ---------- theme picker ---------- */
export function themeButton() {
  return h("button", { class: "ibtn theme-btn", type: "button", "aria-label": "Change theme", title: "Change theme", onclick: (e) => openThemes(e) }, icon("palette"));
}
function wipe(x, y) {
  const w = h("div", { class: "theme-wipe" }); w.style.setProperty("--x", x + "px"); w.style.setProperty("--y", y + "px");
  document.body.append(w); setTimeout(() => w.remove(), 700);
}
export function openThemes(ev) {
  const T = window.CWPTheme;
  const prev = document.activeElement;
  const done = () => { document.removeEventListener("keydown", onKey); back.classList.add("out"); setTimeout(() => back.remove(), 170); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") done(); };
  const grid = h("div", { class: "theme-grid" });
  const paint = () => {
    clear(grid).append(...T.list.map((t) => {
      const on = T.get() === t.id;
      const preview = T.logoNode("theme-logo", t.id);
      const b = h("button", { class: "theme-card" + (on ? " on" : ""), type: "button", "aria-pressed": String(on), onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect(); wipe(r.left + r.width / 2, r.top + r.height / 2);
        T.apply(t.id); toast(`Theme: ${t.name}`); paint();
      } }, preview, h("span", { class: "theme-name", text: t.name }), h("span", { class: "theme-note", text: t.note }),
        (() => { const sw = h("span", { class: "theme-swatch" }); sw.style.background = `linear-gradient(90deg, ${t.c1}, ${t.c2})`; return sw; })());
      return b;
    }));
  };
  paint();
  const back = h("div", { class: "modal-back sheet-back", onclick: (e) => { if (e.target === back) done(); } },
    h("div", { class: "sheet theme-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Choose a theme" },
      h("div", { class: "sheet-grab" }), h("div", { class: "sheet-title", text: "Theme" }),
      h("div", { class: "small muted", text: "Each theme has its own colours and its own logo. The tab icon changes too." }),
      grid, h("button", { class: "sheet-btn cancel", type: "button", text: "Done", onclick: done })));
  document.body.append(back); document.addEventListener("keydown", onKey);
}

/** Centered logo with an animated loader underneath. `compact` is the in-page version. */
export function splash(text = "Loading…", compact = false) {
  return h("div", { class: "splash" + (compact ? " compact" : ""), role: "status" },
    h("div", { class: "splash-logo" }, h("span", { class: "ring" }), logoMark("splash-mark")),
    compact ? null : h("div", { class: "splash-name", text: "CWP SMS" }),
    h("div", { class: "splash-bar", "aria-hidden": "true" }, h("i")),
    h("div", { class: "splash-text", text }));
}

/** Glass confirm dialog. Resolves true/false. Esc and backdrop click cancel. */
export function ask({ title, body = "", confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const done = (v) => { document.removeEventListener("keydown", onKey); back.classList.add("out"); setTimeout(() => back.remove(), 160); prev?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    const ok = h("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button", text: confirm, onclick: () => done(true) });
    const back = h("div", { class: "modal-back", onclick: (e) => { if (e.target === back) done(false); } },
      h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", { text: title }), body ? h("p", { class: "muted", text: body }) : null,
        h("div", { class: "row end-row" }, h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => done(false) }), ok)));
    document.body.append(back); document.addEventListener("keydown", onKey); ok.focus();
  });
}

/** Animates an integer from 0; falls back to the final value when motion is reduced. */
export function countUp(el, to, ms = 700) {
  el.textContent = String(to);
  if (!Number.isFinite(to) || to <= 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / ms); el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(step); };
  el.textContent = "0"; requestAnimationFrame(step);
}

export const STATUS_LABEL = {
  accepted: ["Accepted", "info"], queued: ["Queued", "warn"], assigned: ["Assigned to phone", "warn"],
  sending: ["Sending", "warn"], sent: ["Sent", "ok"], delivery_pending: ["Delivery pending", "info"],
  delivered: ["Delivered", "ok"], failed: ["Failed", "bad"], unknown: ["Outcome unknown", "bad"],
  expired: ["Failed · timed out", "bad"], cancelled: ["Cancelled", "off"], demo_completed: ["Demo", "off"],
};
export function statusPill(s) {
  const [label, tone] = STATUS_LABEL[s] || [s, "off"];
  return h("span", { class: `pill ${tone}`, text: label });
}

const ICON = {
  home: "M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z",
  list: "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01",
  key: "M15 7a4 4 0 11-3.9 4.9L3 20v-3h3v-2h2l2.1-2.1A4 4 0 0115 7z",
  phone: "M8 2h8a2 2 0 012 2v16a2 2 0 01-2 2H8a2 2 0 01-2-2V4a2 2 0 012-2zM11 18h2",
  code: "M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14",
  send: "M21 3L10 14M21 3l-7 18-4-8-8-4 19-6z",
  book: "M4 4h12a3 3 0 013 3v13H7a3 3 0 01-3-3V4zM4 17a3 3 0 013-3h12",
  users: "M16 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-2a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  copy: "M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M9 7V4h6v3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  mail: "M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1zM3.5 7.5L12 13l8.5-5.5",
  lock: "M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V8a4 4 0 018 0v3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeoff: "M3 3l18 18M10.6 5.1A9.7 9.7 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4.1M6.5 6.6A17 17 0 002 12s3.6 7 10 7a9.8 9.8 0 004.1-.9M9.9 9.9a3 3 0 004.2 4.2",
  palette: "M12 3a9 9 0 100 18c1.4 0 2-.9 2-1.8 0-1.2-1-1.6-1-2.7 0-.9.7-1.5 1.7-1.5H17a4 4 0 004-4c0-4.4-4-8-9-8zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01M17 11.5h.01",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
};
export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path"); p.setAttribute("d", ICON[name]); s.append(p);
  return s;
}

/* ---------- liquid-glass navigation: a lens that glides, stretches and magnifies ---------- */
export function liquidNav(nav) {
  let lens = nav.querySelector(".lens");
  if (!lens) { lens = h("span", { class: "lens", "aria-hidden": "true" }, h("i")); nav.prepend(lens); }
  const LIFT = 15, D = 54;
  const links = () => [...nav.querySelectorAll("a")];
  if (!lens.querySelector(".puff")) { // 12 tiny particles, reused for every dissolve (no DOM churn)
    const puff = h("b", { class: "puff", "aria-hidden": "true" }); for (let i = 0; i < 12; i++) puff.append(h("i")); lens.append(puff);
  }
  const lite = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 2 || navigator.connection?.saveData;
  nav.dataset.fx = lite ? "lite" : "full";
  // press = open the capsule and reveal the name; release = the name evaporates and the capsule is a circle again
  const openCap = () => { clearTimeout(closeTimer); nav.classList.remove("dissolve"); if (!nav.classList.contains("open")) { nav.classList.add("open"); } pressedAt = performance.now(); };
  const closeCap = () => {
    clearTimeout(closeTimer);
    if (!nav.classList.contains("open")) return;
    const wait = Math.max(0, 260 - (performance.now() - pressedAt));       // always show the name long enough to read
    closeTimer = setTimeout(() => {
      nav.classList.remove("dissolve"); void nav.offsetWidth; nav.classList.add("dissolve");
      closeTimer = setTimeout(() => { nav.classList.remove("open", "dissolve"); place(current()); }, 300);
    }, wait);
  };
  const current = () => nav.querySelector('a[aria-current="page"]');
  let last = "", moveTimer = 0, closeTimer = 0, pressedAt = 0;
  const EXPANDED = 176;
  const place = (a, instant = false) => {
    if (!a || !a.offsetWidth) return;
    const round = getComputedStyle(nav).flexDirection !== "column";
    let x, y, w, hgt;
    if (round) {
      const ic = a.querySelector("svg");
      w = hgt = D;
      x = a.offsetLeft + a.offsetWidth / 2 - D / 2;
      const cs = getComputedStyle(a);
      const iconMid = ic ? parseFloat(cs.paddingTop) + parseFloat(getComputedStyle(ic).height) / 2 : a.offsetHeight / 2;
      y = a.offsetTop + iconMid - D / 2 - LIFT;
    } else { x = a.offsetLeft; y = a.offsetTop; hgt = a.offsetHeight; w = nav.classList.contains("open") ? EXPANDED : hgt; }
    for (const l of links()) l.classList.toggle("hot", l === a);
    const key = `${x}|${y}|${w}|${hgt}`;
    if (instant) lens.style.transition = "none";
    lens.style.width = w + "px"; lens.style.height = hgt + "px";
    lens.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    lens.classList.add("on");
    if (instant) { void lens.offsetWidth; lens.style.transition = ""; }
    else if (key !== last) { nav.classList.remove("sheen"); void nav.offsetWidth; nav.classList.add("sheen"); lens.classList.add("moving"); clearTimeout(moveTimer); moveTimer = setTimeout(() => lens.classList.remove("moving"), 230); }
    last = key;
  };
  if (!nav._liquid) {
    nav._liquid = true;
    nav.addEventListener("dragstart", (e) => e.preventDefault());
    let down = null, start = null, hover = null;
    const under = (x, y) => {
      const list = links(); const r0 = nav.getBoundingClientRect();
      const col = getComputedStyle(nav).flexDirection === "column";
      if (x < r0.left - 20 || x > r0.right + (col ? EXPANDED : 20) || y < r0.top - (col ? 20 : 40) || y > r0.bottom + (col ? 20 : 30)) return null;
      let best = null, bd = 1e9;
      for (const a of list) { const r = a.getBoundingClientRect(); const d = col ? Math.abs(y - (r.top + r.height / 2)) : Math.abs(x - (r.left + r.width / 2)) + (r.top > r0.top + r0.height / 2 ? Math.abs(y - (r.top + r.height / 2)) * 0.4 : 0); if (d < bd) { bd = d; best = a; } }
      return best;
    };
    nav.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      down = true; start = under(e.clientX, e.clientY); hover = start;
      nav.classList.add("pressing");
      if (getComputedStyle(nav).flexDirection === "column") openCap();
      if (start) place(start);               // the lens moves the instant you touch, not on release
    });
    window.addEventListener("pointermove", (e) => {
      if (!down) return;
      const a = under(e.clientX, e.clientY);
      if (a && a !== hover) { hover = a; nav.classList.add("scrub"); place(a); navigator.vibrate?.(6); }
    }, { passive: true });
    const finish = (commit) => {
      if (!down) return; down = null;
      nav.classList.remove("pressing", "scrub");
      const target = hover; hover = start = null;
      if (commit && target && target !== current()) location.hash = target.getAttribute("href"); // go immediately on release
      else place(current());
      closeCap();
    };
    window.addEventListener("pointerup", () => finish(true));
    window.addEventListener("pointercancel", () => finish(false));
    new ResizeObserver(() => place(current(), true)).observe(nav);
    window.addEventListener("resize", () => place(current(), true));
  }
  requestAnimationFrame(() => place(current(), !lens.classList.contains("on")));
}

/* ---------- long press (touch / mouse) and right-click ---------- */
export function longPress(el, handler, ms = 480) {
  let timer = null, fired = false, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); el.classList.remove("holding"); };
  el.addEventListener("pointerdown", (e) => {
    if (e.button || e.target.closest("button")) return;
    fired = false; sx = e.clientX; sy = e.clientY; el.classList.add("holding");
    timer = setTimeout(() => { fired = true; el.classList.remove("holding"); navigator.vibrate?.(18); handler(e); }, ms);
  });
  el.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  for (const t of ["pointerup", "pointerleave", "pointercancel"]) el.addEventListener(t, cancel);
  // After a long press, swallow the click so a pressed link does not also navigate.
  el.addEventListener("click", (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; } }, true);
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!fired) handler(e); });
}

/** Glass action sheet: title + a list of {label, icon, danger, run}. */
export function sheet(title, actions, subtitle = "") {
  const prev = document.activeElement;
  const done = () => { document.removeEventListener("keydown", onKey); back.classList.add("out"); setTimeout(() => back.remove(), 170); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") done(); };
  const back = h("div", { class: "modal-back sheet-back", onclick: (e) => { if (e.target === back) done(); } },
    h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "sheet-grab" }),
      h("div", { class: "sheet-title mono", text: title }), subtitle ? h("div", { class: "small muted", text: subtitle }) : null,
      h("div", { class: "sheet-actions" }, actions.map((a) => h("button", { class: "sheet-btn" + (a.danger ? " danger" : ""), type: "button", onclick: () => { done(); a.run(); } }, icon(a.icon), a.label))),
      h("button", { class: "sheet-btn cancel", type: "button", text: "Cancel", onclick: done })));
  document.body.append(back); document.addEventListener("keydown", onKey);
}

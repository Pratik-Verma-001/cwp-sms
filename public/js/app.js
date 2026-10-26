import { clear, h, icon, liquidNav, logoMark, session, themeButton } from "./core.js";
import { startAuth } from "./authui.js";
import { devices, docs, keys, overview, requestDetail, requests, send } from "./pages.js";
import { sdk } from "./sdk.js";

const app = document.getElementById("app");

const NAV = [["overview", "Overview", "home"], ["send", "Send", "send"], ["requests", "Requests", "list"], ["keys", "Keys", "key"], ["devices", "Devices", "phone"], ["sdk", "SDK", "code"], ["docs", "API docs", "book"]];
const brand = () => h("div", { class: "brand" }, h("span", { class: "brand-mark" }, logoMark()), "CWP SMS");

/* ---------------- signed-in shell + router ---------------- */
function shell({ signOut }) {
  const main = h("main", { id: "main", tabindex: "-1" });
  const nav = h("nav", { class: "nav", "aria-label": "Main" },
    ...NAV.map(([n, label, ic]) => h("a", { href: `#/${n}`, class: n === "docs" ? "docs-link" : "", dataset: { n } }, icon(ic), h("span", { text: label }))));
  clear(app).append(h("div", { class: "shell" },
    h("header", { class: "top" }, brand(), h("span", { class: "spacer" }), h("span", { class: "who", text: session.email || "" }), themeButton(), h("button", { class: "btn small", type: "button", text: "Sign out", onclick: signOut })),
    nav, main));

  const route = () => {
    const [name = "overview", arg] = location.hash.replace(/^#\/?/, "").split("/");
    const key = NAV.some(([n]) => n === name) ? name : "overview";
    for (const a of nav.querySelectorAll("a")) { if (a.dataset.n === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
    liquidNav(nav);
    main._gen = (main._gen || 0) + 1; // invalidates any page still loading
    clear(main);
    const pages = { overview, send, keys, devices, sdk, docs };
    if (key === "requests") (arg ? requestDetail(main, decodeURIComponent(arg)) : requests(main));
    else pages[key](main);
    window.scrollTo(0, 0);
  };
  window.onhashchange = route;
  route();
}

startAuth({ root: app, title: "Console", subtitle: "Manage API keys, your phone and your SMS requests.", brand, onReady: shell });

import { auth, clear, h, icon, logoMark, restoreSession, session, splash, themeButton, toast } from "./core.js";

/**
 * Shared sign-in flow for the console and the admin panel:
 * config check → restore session → sign in / create account → email-verification gate → onReady().
 */
export function startAuth({ root, title, subtitle, brand, onReady }) {
  const signOut = () => { auth.signOut(); authScreen(); };

  function authScreen(note = "") {
    let mode = "in", busy = false;
    const msg = h("p", { class: "err", role: "alert", text: note });
    const email = h("input", { id: "a-email", type: "email", autocomplete: "email", inputmode: "email", required: true, placeholder: "you@example.com" });
    const pw = h("input", { id: "a-pw", type: "password", autocomplete: "current-password", minlength: "6", required: true, placeholder: "At least 6 characters" });
    const eye = h("button", { class: "eye", type: "button", "aria-label": "Show password", onclick: () => {
      const show = pw.type === "password"; pw.type = show ? "text" : "password";
      eye.setAttribute("aria-label", show ? "Hide password" : "Show password"); clear(eye).append(icon(show ? "eyeoff" : "eye")); } }, icon("eye"));
    const field = (ic, input, extra) => h("div", { class: "input-ic" }, icon(ic), input, extra || null);
    const submit = h("button", { class: "btn primary big", type: "submit", text: "Sign in" });
    const tabs = h("div", { class: "tabs", role: "tablist", dataset: { mode: "in" } });
    const paint = () => {
      tabs.dataset.mode = mode;
      clear(tabs).append(...[["in", "Sign in"], ["up", "Create account"]].map(([m, t]) =>
        h("button", { type: "button", role: "tab", "aria-selected": String(mode === m), text: t, onclick: () => { mode = m; pw.autocomplete = m === "in" ? "current-password" : "new-password"; submit.textContent = t; msg.textContent = ""; paint(); } })));
    };
    const form = h("form", { novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); if (busy) return;
      if (!email.value.trim() || pw.value.length < 6) { msg.textContent = "Enter your email and a password of 6+ characters."; return; }
      busy = true; submit.disabled = true; msg.textContent = "";
      try {
        if (mode === "in") await auth.signIn(email.value.trim(), pw.value); else await auth.signUp(email.value.trim(), pw.value);
        session.email = email.value.trim();
        await gate(mode === "up");
      } catch (er) { msg.textContent = er.message; }
      finally { busy = false; submit.disabled = false; }
    } },
      h("div", { class: "field" }, h("label", { for: "a-email", text: "Email" }), field("mail", email)),
      h("div", { class: "field" }, h("label", { for: "a-pw", text: "Password" }), field("lock", pw, eye)), msg,
      submit,
      h("div", { class: "auth-alt" },
        h("button", { class: "btn small ghost", type: "button", text: "Forgot password?", onclick: async () => {
          if (!email.value.trim()) { msg.textContent = "Type your email first."; return; }
          try { await auth.resetPassword(email.value.trim()); toast("Password reset email sent"); } catch (er) { msg.textContent = er.message; }
        } })));
    paint();
    clear(root).append(h("div", { class: "auth" },
      h("div", { class: "auth-theme" }, themeButton()),
      h("div", { class: "auth-hero" },
        h("div", { class: "auth-logo" }, h("span", { class: "ring" }), logoMark("auth-mark")),
        h("div", { class: "auth-name" }, "CWP SMS", /admin/i.test(title) ? h("span", { class: "pill off", text: "Admin" }) : null),
        h("h1", { text: title }), h("p", { class: "muted", text: subtitle })),
      h("div", { class: "card auth-card" }, tabs, form),
      h("ul", { class: "auth-points" },
        ...[["shield", "Verified email required"], ["phone", "Sends from your own SIM"], ["key", "Keys you can revoke any time"]].map(([ic, t]) => h("li", {}, icon(ic), t)))));
    email.focus();
  }

  async function gate(justCreated = false) {
    let ok = false;
    try { ok = await auth.isVerified(); } catch { ok = false; }
    if (ok) return onReady({ signOut });
    const msg = h("p", { class: "muted", text: justCreated ? "We sent a verification link to your email." : "Your email is not verified yet." });
    clear(root).append(h("div", { class: "auth" }, brand(), h("h1", { text: "Verify your email" }),
      h("div", { class: "card" }, msg, h("p", { class: "small muted", text: `Open the link sent to ${session.email || "your inbox"} (check spam), then continue.` }),
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "I've verified", onclick: async (e) => {
            e.target.disabled = true;
            try { if (await auth.refresh() && await auth.isVerified()) return onReady({ signOut }); msg.textContent = "Still not verified. Open the link in the email first."; }
            catch { msg.textContent = "Could not check. Try again."; }
            e.target.disabled = false; } }),
          h("button", { class: "btn", type: "button", text: "Resend email", onclick: async () => { try { await auth.sendVerification(); toast("Verification email sent"); } catch (er) { toast(er.message, true); } } }),
          h("button", { class: "btn", type: "button", text: "Sign out", onclick: signOut })))));
  }

  (async () => {
    clear(root).append(splash("Checking your session…"));
    let cfg = null;
    try { cfg = await (await fetch("/api/v1/config")).json(); } catch { cfg = null; }
    if (!cfg || !cfg.signInConfigured) {
      clear(root).append(h("div", { class: "auth" }, brand(), h("h1", { text: "Almost ready" }),
        h("div", { class: "banner warn" }, h("div", {}, h("b", { text: "Sign-in is not configured" }), "Set the FIREBASE_WEB_API_KEY environment variable in Vercel (Firebase → Project settings → Web API Key), then redeploy."))));
      return;
    }
    session.apiKey = cfg.firebaseApiKey;
    const t0 = Date.now();
    const restored = restoreSession() && (await auth.refresh());
    if (Date.now() - t0 < 600) await new Promise((r) => setTimeout(r, 600 - (Date.now() - t0)));
    if (restored) return gate();
    authScreen();
  })();
}

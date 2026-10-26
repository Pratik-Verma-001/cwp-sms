import { clear, h } from "./core.js";
import { codeBlock, state } from "./pages.js";

export const SDK_ZIP = "/downloads/cwp-sms-android-sdk.zip";

const ANDROID = {
  "8-9": { label: "Android 8–9", notes: ["Foreground notification channel is created by the SDK; nothing to do."] },
  "10-12": { label: "Android 10–12", notes: ["Android 12 may delay foreground services started from the background. Always start the connector from the visible screen."] },
  "13": { label: "Android 13", notes: ["Android 13 asks for notification permission. Tap Allow — the connector's notification must stay visible, and it carries the Stop button."] },
  "14": { label: "Android 14 or newer", notes: ["Notification permission is required, and the connector runs as a visible foreground service. Start it from the app screen, not from a background task."] },
};

const BRANDS = {
  pixel: { label: "Google Pixel / stock Android", steps: ["Settings → Apps → CWP SMS (your app) → Battery → choose “Unrestricted”."] },
  samsung: { label: "Samsung", steps: ["Settings → Apps → your app → Battery → “Unrestricted”.", "Settings → Battery → Background usage limits → remove your app from “Sleeping apps” and “Deep sleeping apps”."] },
  xiaomi: { label: "Xiaomi / Redmi / POCO", steps: ["Settings → Apps → Manage apps → your app → Autostart: ON.", "Same page → Battery saver → “No restrictions”.", "Recent apps: long-press your app card → lock it."] },
  oppo: { label: "Oppo / Realme / OnePlus", steps: ["Settings → Apps → your app → Battery usage → allow background activity.", "Settings → Battery → turn off “Optimise battery use” for your app, and allow auto-launch."] },
  vivo: { label: "Vivo / iQOO", steps: ["Settings → Battery → Background power consumption → allow your app.", "i Manager → App manager → Autostart: ON."] },
  other: { label: "Other brand", steps: ["Find your phone's “Battery optimisation” or “Background activity” setting and set your app to Unrestricted / Don't optimise."] },
};

export function sdk(root) {
  const sel = { method: "studio", android: "14", brand: "pixel", lang: "kotlin", gradle: "kts" };
  const out = h("div");
  const base = location.origin;

  function select(id, label, key, options) {
    return h("div", { class: "field" }, h("label", { for: id, text: label }),
      h("select", { id, onchange: (e) => { sel[key] = e.target.value; render(); } },
        options.map(([v, t]) => h("option", { value: v, text: t, selected: sel[key] === v }))));
  }

  function render() {
    const key = state.lastConnectorSecret || "PASTE_YOUR_CONNECTOR_KEY";
    const kts = `android {\n    defaultConfig {\n        manifestPlaceholders["cwpBaseUrl"] = "${base}"\n        manifestPlaceholders["cwpApiKey"]  = "${key}"\n    }\n}\n\ndependencies {\n    implementation(project(":cwp-sms-sdk"))\n}`;
    const groovy = `android {\n    defaultConfig {\n        manifestPlaceholders = [\n            cwpBaseUrl: "${base}",\n            cwpApiKey : "${key}"\n        ]\n    }\n}\n\ndependencies {\n    implementation project(':cwp-sms-sdk')\n}`;
    const settingsKts = `include(":cwp-sms-sdk")`;
    const settingsGroovy = `include ':cwp-sms-sdk'`;
    const kotlin = `startActivity(CwpSms.connectIntent(this))`;
    const java = `startActivity(CwpSms.connectIntent(this));`;
    const kts_ = sel.gradle === "kts";
    const a = ANDROID[sel.android], br = BRANDS[sel.brand];

    const WORKFLOW = `name: Build Android APK
on:
  workflow_dispatch: {}
jobs:
  apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: "8.7"
      - name: Build debug APK
        working-directory: android-sdk
        env:
          CWP_BASE_URL: \${{ secrets.CWP_BASE_URL }}
          CWP_CONNECTOR_KEY: \${{ secrets.CWP_CONNECTOR_KEY }}
        run: gradle :sample-app:assembleDebug --no-daemon "-PcwpBaseUrl=$CWP_BASE_URL" "-PcwpApiKey=$CWP_CONNECTOR_KEY"
      - uses: actions/upload-artifact@v4
        with:
          name: cwp-sample-debug-apk
          path: android-sdk/sample-app/build/outputs/apk/debug/*.apk`;
    const sample = `// sample-app/build.gradle.kts → inside defaultConfig { ... }\nmanifestPlaceholders["cwpBaseUrl"] = "${base}"\nmanifestPlaceholders["cwpApiKey"]  = "${key}"`;
    const keyNote = state.lastConnectorSecret
      ? h("div", { class: "note", text: "Your new connector key is filled in. Reload this page and it is gone — keys are shown once." })
      : h("div", { class: "note" }, "Replace PASTE_YOUR_CONNECTOR_KEY with a connector key from the ", h("a", { href: "#/keys", text: "API keys page" }), ". Use a connector key, never your SMS API key.");
    const keyWarn = h("div", { class: "note warn", text: "The key is compiled into the app. A connector key can only enroll your own phone, but keep the repository private." });

    const download = h("li", {}, h("h3", { text: "Download the SDK" }),
      h("p", { text: "A zip with the SDK module, a ready sample app and a README. Same zip for every build method." }),
      h("a", { class: "btn primary", href: SDK_ZIP, download: "cwp-sms-android-sdk.zip", text: "Download SDK (.zip)" }),
      h("div", { class: "note warn", text: "This SDK is new and has not been compiled or run on a real phone yet. If a build fails, copy the error and send it for a fix." }));

    let middle;
    if (sel.method === "studio") {
      middle = [
        h("li", {}, h("h3", { text: "Add it to your Android project" }),
          h("p", { text: "Unzip, copy the cwp-sms-sdk folder next to your app module, then register it:" }),
          h("p", { class: "small muted", text: kts_ ? "settings.gradle.kts" : "settings.gradle" }), codeBlock(kts_ ? settingsKts : settingsGroovy)),
        h("li", {}, h("h3", { text: "Put your base URL and key in build.gradle — that is all the configuration" }),
          h("p", { class: "small muted", text: kts_ ? "app/build.gradle.kts" : "app/build.gradle" }), codeBlock(kts_ ? kts : groovy), keyNote, keyWarn),
        h("li", {}, h("h3", { text: "Open the connector screen from your app" }),
          h("p", { text: "The SDK ships a ready screen with permission prompts, Start/Stop, live status and a Send box (demo or live). One line opens it:" }),
          codeBlock(sel.lang === "kotlin" ? kotlin : java)),
      ];
    } else if (sel.method === "github") {
      middle = [
        h("li", {}, h("h3", { text: "Put the SDK in a private GitHub repo" }),
          h("p", { text: "Unzip it and rename the folder cwp-sms-android-sdk to android-sdk inside your repo (the sample app is already set up, no code to write). Commit and push." })),
        h("li", {}, h("h3", { text: "Add the build workflow" }),
          h("p", { class: "small muted", text: "Create this file in the repo: .github/workflows/android-apk.yml" }), codeBlock(WORKFLOW)),
        h("li", {}, h("h3", { text: "Save your base URL and key as repository secrets" }),
          h("p", {}, "GitHub repo → Settings → Secrets and variables → Actions → New repository secret. Add two:"),
          h("ul", {}, h("li", {}, h("code", { text: "CWP_BASE_URL" }), " = ", h("code", { text: base })), h("li", {}, h("code", { text: "CWP_CONNECTOR_KEY" }), " = your connector key")),
          keyNote, keyWarn),
        h("li", {}, h("h3", { text: "Build and install the APK" }),
          h("p", { text: "Repo → Actions → “Build Android APK” → Run workflow. When it is green, open the run, download the artifact cwp-sample-debug-apk, unzip it and install the .apk on your phone (allow “install unknown apps” when asked). Open the app and tap Open SMS connector." })),
      ];
    } else {
      middle = [
        h("li", {}, h("h3", { text: "Install AndroidIDE on your phone" }),
          h("p", {}, "AndroidIDE is an Android app that builds Android projects on the phone. Get it from its ", h("a", { href: "https://github.com/AndroidIDEOfficial/AndroidIDE/releases", target: "_blank", rel: "noopener noreferrer", text: "GitHub releases page" }), "."),
          h("div", { class: "note warn", text: "Not tested with this SDK. AndroidIDE bundles its own build tools and may not support the newest Android Gradle plugin; if the build fails, send the error text." })),
        h("li", {}, h("h3", { text: "Open the sample app" }),
          h("p", { text: "Unzip the SDK on your phone's storage, then in AndroidIDE choose Open project and select the unzipped cwp-sms-android-sdk folder. Let it sync." })),
        h("li", {}, h("h3", { text: "Put your base URL and key in the sample app" }),
          h("p", { class: "small muted", text: "sample-app/build.gradle.kts" }), codeBlock(sample), keyNote, keyWarn),
        h("li", {}, h("h3", { text: "Build and install" }),
          h("p", { text: "Run the Gradle task assembleDebug (Build → Quick Run, or the sample-app:assembleDebug task), then install the APK it produces and tap Open SMS connector." })),
      ];
    }

    clear(out).append(h("ol", { class: "steps" }, download, ...middle,
      h("li", {}, h("h3", { text: `On the phone (${a.label})` }),
        h("ul", {}, h("li", { text: "Tap Start connector. Allow the SMS permission when asked." }), a.notes.map((n) => h("li", { text: n })),
          h("li", { text: "A notification stays visible while the connector runs. Tap Stop in it at any time." }))),
      h("li", {}, h("h3", { text: `Keep it alive (${br.label})` }),
        h("p", { text: "Phones kill background apps to save battery. Without this the phone goes offline." }),
        h("ul", {}, br.steps.map((s) => h("li", { text: s })))),
      h("li", {}, h("h3", { text: "Check it worked" }),
        h("p", {}, "Open ", h("a", { href: "#/devices", text: "Devices" }), " — your phone should show Online within a minute. Then send a demo request from the ", h("a", { href: "#/docs", text: "API docs" }), "."))));
  }

  clear(root).append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Android SDK" }), h("p", { text: "Your app needs only a base URL and a connector key in build.gradle." }))),
    h("div", { class: "card" }, h("h2", { text: "Your phone" }),
      h("div", { class: "formgrid" },
        select("s-method", "How will you build?", "method", [["studio", "Android Studio (computer)"], ["github", "GitHub Actions (phone only)"], ["androidide", "AndroidIDE (on the phone)"]]),
        select("s-android", "Android version", "android", Object.entries(ANDROID).map(([v, o]) => [v, o.label])),
        select("s-brand", "Phone brand", "brand", Object.entries(BRANDS).map(([v, o]) => [v, o.label])),
        select("s-lang", "Language", "lang", [["kotlin", "Kotlin"], ["java", "Java"]]),
        select("s-gradle", "Build files", "gradle", [["kts", "Gradle Kotlin DSL (.kts)"], ["groovy", "Gradle Groovy (.gradle)"]]))),
    h("div", { class: "card" }, out));
  render();
}

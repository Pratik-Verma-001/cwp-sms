# CWP SMS Android SDK

Turns an Android phone into the SIM that sends your CWP SMS requests.

**Status: new and unverified.** It has not been compiled or run on a real device by its author. Build it in
Android Studio, try a *demo* request first, and report any build error.

## Setup (this is all of it)

1. Copy the `cwp-sms-sdk` folder into your project and add `include(":cwp-sms-sdk")` to `settings.gradle(.kts)`.
2. In your app's `build.gradle(.kts)`:

   ```kotlin
   android { defaultConfig {
       manifestPlaceholders["cwpBaseUrl"] = "https://YOUR-PROJECT.vercel.app"
       manifestPlaceholders["cwpApiKey"]  = "cwp_live_..."   // a CONNECTOR key from the dashboard
   } }
   dependencies { implementation(project(":cwp-sms-sdk")) }
   ```
3. Open the connector screen from anywhere: `startActivity(CwpSms.connectIntent(this))`.

The sample-app folder is a complete example; open this folder in Android Studio.

## Behaviour you can rely on

- Never starts on its own. The user taps Start; a notification with a Stop button stays up while it runs.
- Sends only what your account's API created. Asks for the SMS permission; carrier charges apply.
- Tells the server "sending" *before* handing a message to the SIM. If that call fails, nothing is sent.
- Reports "sent" and "delivered" only from the platform's own callbacks. A lost report leaves the job as "sending",
  which the server never retries, so a person is not texted twice.
- The screen also has a **Send** box. It creates a request on your account through this phone's own credential, with the same limits, live/demo switches and online-phone check as the dashboard.
- Use a **connector** key here, never your SMS API key. A connector key can enroll a phone; once enrolled, that phone can create requests for your account (limited by your quotas). Anyone who extracts the key from the APK could do the same, so keep the APK and repository private, and revoke the key if it leaks.
- The key is compiled into the APK. Do not commit it to a public repository.

## Keep it alive

Many phone brands stop background apps. Follow the brand steps on the dashboard's Android SDK page.

Distribution note: Google Play restricts SMS permissions. Sideloading is fine for personal use; check the policy before publishing.

## Building without a computer

- **GitHub Actions:** put this folder in a private repo as `android-sdk/`, add `.github/workflows/android-apk.yml`
  (see the dashboard's Android SDK page, or the copy in the project root), add secrets `CWP_BASE_URL` and
  `CWP_CONNECTOR_KEY`, run the workflow and download the APK artifact.
- **AndroidIDE** (on-phone IDE): open this folder, edit `sample-app/build.gradle.kts`, run `assembleDebug`. Untested with this SDK.

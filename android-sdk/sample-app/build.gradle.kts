plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cwp.sample"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.cwp.sample"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // ---- the ONLY configuration the CWP SDK needs ----
        // Edit these two lines, or pass -PcwpBaseUrl=... -PcwpApiKey=... (GitHub Actions does this from secrets).
        manifestPlaceholders["cwpBaseUrl"] = (findProperty("cwpBaseUrl") as String?) ?: "https://YOUR-PROJECT.vercel.app"
        manifestPlaceholders["cwpApiKey"] = (findProperty("cwpApiKey") as String?) ?: "cwp_live_PASTE_YOUR_CONNECTOR_KEY"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":cwp-sms-sdk"))
}

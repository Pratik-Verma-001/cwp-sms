package com.cwp.sms

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/** Public entry point. The only setup is the two build.gradle placeholders; then open [connectIntent]. */
object CwpSms {
    /** Opens the ready-made connector screen (permissions, Start/Stop, live status). */
    @JvmStatic
    fun connectIntent(context: Context): Intent = Intent(context, ConnectActivity::class.java)

    internal class Config(val baseUrl: String, val apiKey: String)

    internal fun config(context: Context): Config {
        val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        val meta = info.metaData
        val base = meta?.getString("com.cwp.sms.BASE_URL")?.trim()?.trimEnd('/').orEmpty()
        val key = meta?.getString("com.cwp.sms.API_KEY")?.trim().orEmpty()
        require(base.startsWith("https://") || base.startsWith("http://")) { "cwpBaseUrl must start with https://" }
        require(key.startsWith("cwp_")) { "cwpApiKey must be a CWP connector key (cwp_live_...)" }
        return Config(base, key)
    }
}

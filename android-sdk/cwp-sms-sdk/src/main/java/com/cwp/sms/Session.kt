package com.cwp.sms

import android.content.Context
import android.os.Build

internal object Session {
    fun appVersion(context: Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()?.take(32) ?: "1.0"

    /** Returns this phone's device credential, registering with the connector key the first time. Blocking. */
    @Synchronized
    fun credential(context: Context): String {
        val store = Store(context)
        store.credential?.let { return it }
        val cfg = CwpSms.config(context)
        val c = Api(cfg.baseUrl).register(cfg.apiKey, Build.MODEL.take(40), appVersion(context), store.installId)
        store.credential = c
        return c
    }
}

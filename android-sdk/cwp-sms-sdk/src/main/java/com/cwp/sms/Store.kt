package com.cwp.sms

import android.content.Context
import java.util.UUID

/** Private app storage for this phone's device credential (never shown to the user). */
internal class Store(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("cwp_sms", Context.MODE_PRIVATE)

    var credential: String?
        get() = prefs.getString("credential", null)
        set(v) { prefs.edit().apply { if (v == null) remove("credential") else putString("credential", v) }.apply() }

    val installId: String
        get() = prefs.getString("installId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("installId", it).apply() }
}

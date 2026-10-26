package com.cwp.sms

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * Switches the launcher icon to match the theme. The host app declares one <activity-alias> per theme
 * (see sample-app) and sets the meta-data com.cwp.sms.ICON_ALIAS_PREFIX; without it this does nothing.
 */
internal object IconAlias {
    fun apply(context: Context, themeId: String) {
        val pm = context.packageManager
        val prefix = try {
            pm.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData?.getString("com.cwp.sms.ICON_ALIAS_PREFIX")
        } catch (_: Exception) { null } ?: return
        fun name(id: String) = ComponentName(context.packageName, prefix + id.replaceFirstChar { it.uppercase() })
        fun set(id: String, on: Boolean) {
            try {
                pm.setComponentEnabledSetting(name(id),
                    if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            } catch (_: Exception) { /* alias missing: keep the current icon */ }
        }
        set(themeId, true)                       // enable the new one first so the app never loses its launcher entry
        for (t in Ui.themes) if (t.id != themeId) set(t.id, false)
    }
}

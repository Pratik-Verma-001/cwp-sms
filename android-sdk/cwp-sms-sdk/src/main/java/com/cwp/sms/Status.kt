package com.cwp.sms

/** Process-wide, read by the connector screen. Never holds message text or numbers. */
internal object Status {
    @Volatile var running = false
    @Volatile var line = "Stopped"
    @Volatile var liveAllowed: Boolean? = null
    @Volatile var blockedBy: List<String> = emptyList()
    @Volatile var sentThisSession = 0
    @Volatile var failedThisSession = 0
    @Volatile var lastSms = ""
}

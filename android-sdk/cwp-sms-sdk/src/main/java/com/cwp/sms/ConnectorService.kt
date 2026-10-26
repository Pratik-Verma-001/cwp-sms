package com.cwp.sms

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.telephony.SmsManager
import org.json.JSONObject

/**
 * Visible foreground service: while it runs a notification is always shown, with a Stop button.
 * It never starts by itself; the user starts it from the connector screen.
 */
class ConnectorService : Service() {
    @Volatile private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopWorker("Stopped")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        if (worker == null) {
            Status.running = true
            Status.line = "Starting…"
            worker = Thread({ loop() }, "cwp-connector").also { it.start() }
        }
        return START_NOT_STICKY // never silently restarts after being killed
    }

    override fun onDestroy() {
        stopWorker(Status.line.takeIf { !Status.running } ?: "Stopped")
        super.onDestroy()
    }

    private fun stopWorker(line: String) {
        worker?.interrupt()
        worker = null
        Status.running = false
        Status.line = line
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "SMS connector", NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ConnectorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(this, 2, CwpSms.connectIntent(this), PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val n = builder
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("CWP SMS connector is running")
            .setContentText("This phone can send SMS requests from your account. Tap Stop to end.")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIF_ID, n)
    }

    private fun hasSmsPermission() = checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
    private fun hasTelephony() = packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    private fun appVersion(): String = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull()?.take(32) ?: "1.0"

    /** Errors that retrying can never fix. Everything else (network, server hiccup) is retried with backoff. */
    private val fatal = setOf(
        "DEVICE_REVOKED", "INVALID_DEVICE_CREDENTIAL", "CONNECTOR_KEY_INACTIVE", "API_KEY_INACTIVE",
        "INVALID_API_KEY", "DEVICE_LIMIT_REACHED", "ACCOUNT_SUSPENDED", "INSUFFICIENT_SCOPE",
    )

    private fun loop() {
        val config = try { CwpSms.config(this) } catch (e: Exception) {
            fail("Setup problem: ${e.message}"); stopSelfSafely(); return
        }
        val api = Api(config.baseUrl)
        val store = Store(this)
        var lastBeat = 0L
        var backoff = POLL_MS
        try {
            while (!Thread.currentThread().isInterrupted) {
                try {
                    if (store.credential == null) {
                        Status.line = "Registering this phone…"
                        store.credential = Session.credential(this)
                    }
                    val cred = store.credential ?: break
                    val now = System.currentTimeMillis()
                    if (now - lastBeat >= HEARTBEAT_MS) {
                        val hb = api.heartbeat(cred, true, hasSmsPermission(), hasTelephony(), appVersion())
                        lastBeat = now
                        Status.liveAllowed = hb.optBoolean("liveSendingAllowed")
                        Status.blockedBy = hb.optJSONArray("liveBlockedBy")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
                        Status.line = when {
                            !hasSmsPermission() -> "Waiting: SMS permission is missing"
                            Status.liveAllowed != true -> "Online, but live sending is off for your account"
                            else -> "Online and ready"
                        }
                    }
                    if (hasSmsPermission() && Status.liveAllowed == true) {
                        val job = api.claim(cred)
                        if (job != null) { handle(api, cred, job); backoff = POLL_MS; continue }
                    }
                    backoff = POLL_MS
                    Thread.sleep(POLL_MS)
                } catch (e: InterruptedException) {
                    throw e
                } catch (e: ApiError) {
                    if (e.code in fatal) throw e
                    Status.line = "Server busy (${e.code}). Retrying in ${backoff / 1000}s…"
                    Thread.sleep(backoff)
                    backoff = minOf(backoff * 2, 60_000L)
                } catch (e: Exception) {
                    // A dropped connection must not end the connector: say what happened and try again.
                    Status.line = "Connection problem (${e.javaClass.simpleName}). Retrying in ${backoff / 1000}s…"
                    Thread.sleep(backoff)
                    backoff = minOf(backoff * 2, 60_000L)
                }
            }
        } catch (e: InterruptedException) {
            // Stopped by the user.
        } catch (e: ApiError) {
            when (e.code) {
                "DEVICE_REVOKED", "INVALID_DEVICE_CREDENTIAL" -> { store.credential = null; fail("This phone was removed in the dashboard. Press Start to connect again.") }
                "CONNECTOR_KEY_INACTIVE", "API_KEY_INACTIVE" -> { store.credential = null; fail("The connector key was revoked. Create a new one and rebuild the app.") }
                "INVALID_API_KEY" -> fail("The connector key in build.gradle is wrong.")
                "DEVICE_LIMIT_REACHED" -> fail("Another phone is already connected. Remove it in the dashboard first.")
                "ACCOUNT_SUSPENDED" -> fail("Your account is suspended. Contact the administrator.")
                else -> fail("Stopped: ${e.code}")
            }
        } catch (e: Exception) {
            fail("Stopped: ${e.javaClass.simpleName}")
        }
        // Tell the server this phone is no longer running so new live requests are refused straight away.
        store.credential?.let { c -> runCatching { api.heartbeat(c, false, hasSmsPermission(), hasTelephony(), appVersion()) } }
        stopSelfSafely()
    }

    private fun fail(line: String) { Status.line = line; Status.running = false }

    private fun stopSelfSafely() {
        Status.running = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Tell the server "sending" first; only if that succeeds do we hand the message to the SIM. */
    private fun handle(api: Api, cred: String, job: JSONObject) {
        val id = job.getString("id")
        val version = job.getInt("claimVersion")
        try {
            api.result(cred, id, JSONObject().put("claimVersion", version).put("event", "sending"))
        } catch (e: ApiError) {
            if (e.code == "LEASE_EXPIRED" || e.code == "STALE_CLAIM") return // the server will re-queue it; do not send
            throw e
        }
        val to = job.getString("to")
        val text = job.getString("message")
        try {
            val sms = smsManager()
            val parts = sms.divideMessage(text)
            SmsResultReceiver.expect(id, parts.size)
            val sent = ArrayList<PendingIntent>()
            val delivered = ArrayList<PendingIntent>()
            for (i in parts.indices) {
                sent += pending(id, version, SmsResultReceiver.ACTION_SENT, i)
                delivered += pending(id, version, SmsResultReceiver.ACTION_DELIVERED, i)
            }
            Status.lastSms = "Handing the message to the SIM…"
            sms.sendMultipartTextMessage(to, null, parts, sent, delivered)
            Status.lastSms = "Handed to the SIM. Waiting for the phone's sent confirmation…"
            Thread {
                try { Thread.sleep(60_000) } catch (_: InterruptedException) { return@Thread }
                if (SmsResultReceiver.waitingForSent(id)) Status.lastSms =
                    "No sent confirmation after 60s. Your phone may be asking you to allow sending SMS (check for a pop-up or Settings > Apps > SMS permission), or the SIM/carrier is blocking it."
            }.start()
        } catch (e: Exception) {
            Status.lastSms = "Could not send: ${e.javaClass.simpleName}${e.message?.let { m -> " - $m" } ?: ""}"
            // Failed before the message reached the radio, so it is safe to report a definitive failure.
            runCatching { api.result(cred, id, JSONObject().put("claimVersion", version).put("event", "send_result").put("sendCallback", "failure")) }
            Status.failedThisSession++
        }
    }

    /** Use the SIM the phone has chosen for SMS (matters on dual-SIM phones). */
    private fun smsManager(): SmsManager {
        val base = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
        return try {
            val id = android.telephony.SubscriptionManager.getDefaultSmsSubscriptionId()
            if (id != android.telephony.SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
                if (Build.VERSION.SDK_INT >= 31) base.createForSubscriptionId(id)
                else @Suppress("DEPRECATION") SmsManager.getSmsManagerForSubscriptionId(id)
            } else base
        } catch (_: Exception) { base }
    }

    private fun pending(jobId: String, version: Int, action: String, part: Int): PendingIntent {
        val i = Intent(this, SmsResultReceiver::class.java).setAction(action)
            .putExtra("jobId", jobId).putExtra("claimVersion", version).putExtra("part", part)
        return PendingIntent.getBroadcast(this, (jobId.hashCode() * 31 + part) * 2 + (if (action == SmsResultReceiver.ACTION_SENT) 0 else 1), i,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        const val ACTION_STOP = "com.cwp.sms.STOP"
        private const val CHANNEL = "cwp_connector"
        private const val NOTIF_ID = 4711
        private const val HEARTBEAT_MS = 30_000L
        private const val POLL_MS = 5_000L

        fun start(context: Context) {
            val i = Intent(context, ConnectorService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        }
        fun stop(context: Context) {
            context.startService(Intent(context, ConnectorService::class.java).setAction(ACTION_STOP))
        }
    }
}

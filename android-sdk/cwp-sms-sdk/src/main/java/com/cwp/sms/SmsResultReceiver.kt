package com.cwp.sms

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsMessage
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Receives the platform's "sent" and "delivered" callbacks and reports them to the server.
 * For multi-part messages the result is reported once every part has reported. If the process dies
 * first, nothing is reported and the server leaves the job as "sending" (never retried, never "delivered").
 */
class SmsResultReceiver : BroadcastReceiver() {

    private class Tracker(var sentLeft: Int, var deliveredLeft: Int, var failed: Boolean = false, var failCode: Int = 0, var permanentFail: Boolean = false, var notConfirmed: Boolean = false)

    override fun onReceive(context: Context, intent: Intent) {
        val jobId = intent.getStringExtra("jobId") ?: return
        val version = intent.getIntExtra("claimVersion", 0)
        val code = resultCode
        val pdu = intent.getByteArrayExtra("pdu")
        val format = intent.getStringExtra("format")
        val action = intent.action
        val pending = goAsync()
        Thread {
            try {
                val cred = Store(context).credential ?: return@Thread
                val api = Api(CwpSms.config(context).baseUrl)
                val t = trackers[jobId] ?: return@Thread
                if (action == ACTION_SENT) {
                    val report: JSONObject? = synchronized(t) {
                        if (code != Activity.RESULT_OK) { t.failed = true; t.failCode = code }
                        t.sentLeft--
                        if (t.sentLeft > 0) null
                        else JSONObject().put("event", "send_result").put("sendCallback", if (t.failed) "failure" else "success")
                            .also { if (t.failed) it.put("telephonyErrorCode", t.failCode) }
                    }
                    if (report != null) {
                        report.put("claimVersion", version)
                        runCatching { api.result(cred, jobId, report) }
                        if (t.failed) { Status.failedThisSession++; Status.lastSms = "Phone reported a send failure (${errName(t.failCode)})."; trackers.remove(jobId) }
                        else { Status.sentThisSession++; Status.lastSms = "Sent by the phone. Waiting for the carrier's delivery report…" }
                    }
                } else if (action == ACTION_DELIVERED) {
                    // GSM status-report codes: 0 = delivered, 32..63 = still trying, 64+ = permanent failure.
                    // If the report cannot be read we must NOT call it a failure: the message may well have arrived.
                    val st: Int? = runCatching { SmsMessage.createFromPdu(pdu, format).status }.getOrNull()
                    val report: String? = synchronized(t) {
                        when {
                            st == null -> t.notConfirmed = true
                            st >= 64 -> t.permanentFail = true
                            st != 0 -> t.notConfirmed = true
                        }
                        t.deliveredLeft--
                        when {
                            t.deliveredLeft > 0 -> null
                            t.permanentFail -> "failed"
                            t.notConfirmed -> if (st == null) "unsupported" else "pending"
                            else -> "confirmed"
                        }
                    }
                    if (report != null) {
                        Status.lastSms = when (report) { "confirmed" -> "Delivered."; "failed" -> "Carrier says it was not delivered."; "pending" -> "Delivery still pending."; else -> "Sent (this carrier gives no delivery report)." }
                        runCatching { api.result(cred, jobId, JSONObject().put("claimVersion", version).put("event", "delivery_report").put("deliveryReport", report)) }
                        trackers.remove(jobId)
                    }
                }
            } catch (_: Exception) {
                // Reporting is best effort; the server never treats a missing report as delivered.
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val ACTION_SENT = "com.cwp.sms.SENT"
        const val ACTION_DELIVERED = "com.cwp.sms.DELIVERED"
        private val trackers = ConcurrentHashMap<String, Tracker>()
        internal fun waitingForSent(jobId: String): Boolean = trackers[jobId]?.let { synchronized(it) { it.sentLeft > 0 } } ?: false
        private fun errName(code: Int) = when (code) {
            1 -> "generic failure"; 2 -> "radio off"; 3 -> "no PDU"; 4 -> "no service"; 5 -> "limit exceeded"; 6 -> "FDN check failure"
            7 -> "short code not allowed"; 8 -> "short code never allowed"; else -> "code $code"
        }
        internal fun expect(jobId: String, parts: Int) { trackers[jobId] = Tracker(parts, parts) }
    }
}

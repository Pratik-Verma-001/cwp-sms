package com.cwp.sms

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

internal class ApiError(val status: Int, val code: String, message: String) : IOException(message)

/** Minimal JSON client for the CWP connector protocol. Blocking: call from a background thread. */
internal class Api(private val baseUrl: String) {

    private fun call(method: String, path: String, bearer: String, body: JSONObject?): JSONObject {
        val conn = (URL("$baseUrl/api/v1$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("Authorization", "Bearer $bearer")
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (status !in 200..299) {
                val err = json.optJSONObject("error")
                throw ApiError(status, err?.optString("code") ?: "HTTP_$status", err?.optString("message") ?: "Request failed")
            }
            return json
        } finally {
            conn.disconnect()
        }
    }

    /** Exchanges the connector key for this phone's device credential (shown by the server once). */
    fun register(connectorKey: String, nickname: String, appVersion: String, installId: String): String =
        call(
            "POST", "/connector/register", connectorKey,
            JSONObject().put("nickname", nickname).put("appVersion", appVersion).put("installId", installId),
        ).getString("credential")

    fun heartbeat(credential: String, running: Boolean, smsPermission: Boolean, telephony: Boolean, appVersion: String): JSONObject =
        call(
            "POST", "/connector/heartbeat", credential,
            JSONObject().put("connectorRunning", running).put("smsPermissionGranted", smsPermission)
                .put("telephonyAvailable", telephony).put("appVersion", appVersion),
        )

    /** Creates a request for this phone's own account (demo or live). Same server rules as the dashboard. */
    fun send(credential: String, to: String, message: String, mode: String, idempotencyKey: String): JSONObject =
        call(
            "POST", "/connector/send", credential,
            JSONObject().put("to", to).put("message", message).put("mode", mode).put("idempotencyKey", idempotencyKey),
        )

    /** Real test: asks the server to text a 6-digit code to [phone] through this phone's own SIM. */
    fun otpSend(credential: String, phone: String): JSONObject =
        call("POST", "/connector/otp/send", credential, JSONObject().put("phone", phone))

    fun otpVerify(credential: String, phone: String, code: String): JSONObject =
        call("POST", "/connector/otp/verify", credential, JSONObject().put("phone", phone).put("code", code))

    fun claim(credential: String): JSONObject? =
        call("POST", "/connector/jobs/claim", credential, JSONObject()).optJSONObject("job")

    fun result(credential: String, jobId: String, body: JSONObject): JSONObject =
        call("POST", "/connector/jobs/$jobId/result", credential, body)
}

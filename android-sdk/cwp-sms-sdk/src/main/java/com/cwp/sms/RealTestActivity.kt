package com.cwp.sms

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Real test flow inside the app: phone number -> real SMS code (through this phone's SIM and the CWP pipeline)
 * -> verified on the server -> calculator. The calculator is only built after the server confirms the code.
 */
class RealTestActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private var phone = ""
    private var resendAt = 0L
    private var tick: Runnable? = null
    private val engine = CalcEngine()

    private fun dp(v: Int) = Ui.dp(this, v)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Ui.load(this)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.BLACK
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        root = FrameLayout(this)
        setContentView(root)
        showPhone()
    }

    override fun onDestroy() { watchGen++; tick?.let { ui.removeCallbacks(it) }; super.onDestroy() }

    // ---------- shared bits ----------
    private fun label(text: String, sp: Float, color: Int = Ui.text, bold: Boolean = false) = TextView(this).apply {
        this.text = text; setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun primary(text: String, onTap: () -> Unit) = TextView(this).apply {
        this.text = text; gravity = Gravity.CENTER; setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setTypeface(typeface, Typeface.BOLD); setPadding(dp(16), dp(15), dp(16), dp(15)); isClickable = true
        background = Ui.gradientButton(this@RealTestActivity, Ui.cyan, Ui.violet)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
        setOnClickListener { onTap() }
    }

    private fun link(text: String, onTap: () -> Unit) = label(text, 14f, Ui.muted).apply {
        gravity = Gravity.CENTER; setPadding(dp(8), dp(14), dp(8), dp(8)); isClickable = true; setOnClickListener { onTap() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun input(hint: String) = EditText(this).apply {
        this.hint = hint; setHintTextColor(Ui.faint); setTextColor(Ui.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        background = Ui.glass(this@RealTestActivity, 16, true); setPadding(dp(16), dp(14), dp(16), dp(14)); setSingleLine()
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
    }

    /** Glass page with logo, title and a body card. */
    private fun page(title: String, subtitle: String, body: LinearLayout.() -> Unit) {
        tick?.let { ui.removeCallbacks(it) }
        root.removeAllViews()
        root.background = Ui.background()
        root.addView(Ui.orb(this, Ui.cyan, dp(320), -dp(120), -dp(60)))
        root.addView(Ui.orb(this, Ui.violet, dp(360), dp(120), dp(380)))
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(40), dp(20), dp(28)) }
        col.addView(LogoView(this), LinearLayout.LayoutParams(dp(64), dp(64)))
        col.addView(label(title, 26f, bold = true).apply { setPadding(0, dp(18), 0, 0) })
        col.addView(label(subtitle, 14f, Ui.muted).apply { setPadding(0, dp(4), 0, 0) })
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = Ui.glass(this@RealTestActivity); setPadding(dp(20), dp(20), dp(20), dp(20))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(22) }
        }
        card.body()
        col.addView(card)
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(col) })
    }

    private fun busy(btn: TextView, on: Boolean, idle: String) { btn.isEnabled = !on; btn.alpha = if (on) 0.6f else 1f; btn.text = if (on) "Please wait…" else idle }

    private fun friendly(e: Exception): String = when (e) {
        is ApiError -> when (e.code) {
            "NO_ELIGIBLE_DEVICE" -> "Your phone isn't online. Go back, tap Start connector, then try again (the code is sent through your SIM)."
            "LIVE_SENDING_DISABLED" -> "Live sending is off for your account or the platform, so a real code can't be sent."
            "QUOTA_EXCEEDED" -> "You have used today's SMS limit."
            "RATE_LIMITED" -> "Too many requests. Wait a minute."
            "DEVICE_REVOKED", "INVALID_DEVICE_CREDENTIAL", "CONNECTOR_KEY_INACTIVE" -> { Store(this).credential = null; "This phone was removed or its key was revoked. Go back and start the connector again." }
            else -> e.message ?: "Request failed (${e.code})."
        }
        else -> "Connection problem. Check your internet and try again."
    }

    // ---------- step 1: phone ----------
    private fun normalize(raw: String): String? {
        val t = raw.replace(Regex("[\\s()-]"), "")
        val n = when {
            t.startsWith("+") -> t
            Regex("^\\d{10}$").matches(t) -> "+91$t"          // plain 10-digit number: assume India
            Regex("^\\d{11,15}$").matches(t) -> "+$t"
            else -> return null
        }
        return if (Regex("^\\+[1-9]\\d{6,14}$").matches(n)) n else null
    }

    private fun showPhone(prefill: String = "", notice: String = "") {
        lateinit var field: EditText; lateinit var err: TextView; lateinit var btn: TextView
        page("Real test", "Verify your number, then open the calculator.") {
            addView(label("Phone number to verify", 13f, Ui.muted))
            field = input("+91 98765 43210").apply { inputType = InputType.TYPE_CLASS_PHONE; setText(prefill) }
            addView(field)
            err = label(notice, 13f, Ui.bad).apply { setPadding(0, dp(10), 0, 0); visibility = if (notice.isEmpty()) View.GONE else View.VISIBLE }
            addView(err)
            btn = primary("Send OTP") {}
            btn.setOnClickListener {
                val n = normalize(field.text.toString())
                if (n == null) { err.text = "Enter a valid number with country code, e.g. +919876543210."; err.visibility = View.VISIBLE; return@setOnClickListener }
                err.visibility = View.GONE
                busy(btn, true, "Send OTP")
                requestOtp(n, onFail = { m -> busy(btn, false, "Send OTP"); err.text = m; err.visibility = View.VISIBLE })
            }
            addView(btn)
            addView(label("This phone sends the code by SMS through its own SIM, so enter ANOTHER phone's number (a friend's, or the number of your second SIM). A SIM cannot text its own number: the phone shows \"sending... failed\" and the code never arrives. Carrier charges may apply.", 12f, Ui.warn).apply { setPadding(0, dp(14), 0, 0) })
            addView(link("Back to connector") { finish() })
        }
    }

    private fun requestOtp(n: String, onFail: (String) -> Unit) {
        Thread {
            try {
                val cred = Session.credential(this)
                Api(CwpSms.config(this).baseUrl).otpSend(cred, n)
                runOnUiThread { phone = n; resendAt = System.currentTimeMillis() + 30_000; showOtp() }
            } catch (e: Exception) {
                val code = (e as? ApiError)?.code
                // Too soon after a previous code: still let the user enter the one they already have.
                if (code == "OTP_TOO_SOON") runOnUiThread { phone = n; showOtp() }
                else runOnUiThread { onFail(friendly(e)) }
            }
        }.start()
    }

    // ---------- step 2: OTP ----------
    private fun showOtp(notice: String = "") {
        lateinit var field: EditText; lateinit var err: TextView; lateinit var btn: TextView; lateinit var resend: TextView; lateinit var smsLine: TextView
        page("Enter the code", "We texted a 6-digit code to $phone.") {
            field = input("••••••").apply {
                inputType = InputType.TYPE_CLASS_NUMBER; gravity = Gravity.CENTER; setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
                letterSpacing = 0.4f; filters = arrayOf(android.text.InputFilter.LengthFilter(6))
            }
            addView(field)
            smsLine = label("Sending the SMS through your SIM…", 13f, Ui.muted).apply { setPadding(0, dp(12), 0, 0); gravity = Gravity.CENTER }
            addView(smsLine)
            err = label(notice, 13f, Ui.bad).apply { setPadding(0, dp(10), 0, 0); gravity = Gravity.CENTER; visibility = if (notice.isEmpty()) View.GONE else View.VISIBLE }
            addView(err)
            btn = primary("Verify") {}
            val verify: () -> Unit = {
                val code = field.text.toString()
                if (code.length != 6) { err.text = "Enter all 6 digits."; err.visibility = View.VISIBLE }
                else {
                    err.visibility = View.GONE; busy(btn, true, "Verify")
                    Thread {
                        try {
                            Api(CwpSms.config(this@RealTestActivity).baseUrl).otpVerify(Session.credential(this@RealTestActivity), phone, code)
                            runOnUiThread { showCalculator() }
                        } catch (e: Exception) {
                            val c = (e as? ApiError)?.code
                            runOnUiThread {
                                busy(btn, false, "Verify"); err.text = friendly(e); err.visibility = View.VISIBLE
                                if (c == "OTP_INVALID") field.setText("")
                                if (c == "OTP_EXPIRED" || c == "OTP_LOCKED" || c == "OTP_NOT_FOUND") field.setText("")
                            }
                        }
                    }.start()
                }
            }
            btn.setOnClickListener { verify() }
            field.addTextChangedListener(object : TextWatcher {
                override fun afterTextChanged(s: Editable?) { if ((s?.length ?: 0) == 6 && btn.isEnabled) verify() }
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            })
            addView(btn)
            resend = link("") {}
            addView(resend)
            addView(link("Use a different number") { showPhone(phone) })
        }
        // resend countdown
        val t = object : Runnable {
            override fun run() {
                val left = ((resendAt - System.currentTimeMillis()) / 1000).toInt()
                if (left > 0) { resend.text = "Resend code in ${left}s"; resend.isEnabled = false; resend.setTextColor(Ui.faint); resend.setOnClickListener(null); ui.postDelayed(this, 1000) }
                else {
                    resend.text = "Resend code"; resend.setTextColor(Ui.text); resend.isEnabled = true
                    resend.setOnClickListener {
                        resend.text = "Sending…"; resend.isEnabled = false
                        requestOtp(phone, onFail = { m -> err.text = m; err.visibility = View.VISIBLE; resend.text = "Resend code"; resend.isEnabled = true })
                    }
                }
            }
        }
        tick = t; ui.post(t)
        field.requestFocus()
        watchSms(smsLine, btn)
    }

    /** Polls the server for what really happened to the SMS and shows it, so a failed send is never hidden. */
    private fun watchSms(line: TextView, verifyBtn: TextView) {
        val gen = ++watchGen
        Thread {
            var tries = 0
            while (gen == watchGen && tries < 40) {
                tries++
                val r = try { Api(CwpSms.config(this).baseUrl).otpStatus(Session.credential(this)) } catch (e: Exception) { null }
                val state = r?.optString("state") ?: "none"
                val code = r?.optString("errorCode").orEmpty()
                if (gen != watchGen) return@Thread
                runOnUiThread {
                    if (gen != watchGen) return@runOnUiThread
                    when (state) {
                        "sent" -> { line.text = "SMS sent \u2713 It should arrive in a few seconds."; line.setTextColor(Ui.ok) }
                        "failed" -> {
                            line.text = failText(code); line.setTextColor(Ui.bad)
                            verifyBtn.isEnabled = false; verifyBtn.alpha = 0.5f
                        }
                        else -> { line.text = "Sending the SMS through your SIM\u2026"; line.setTextColor(Ui.muted) }
                    }
                }
                if (state == "sent" || state == "failed") return@Thread
                try { Thread.sleep(2000) } catch (_: InterruptedException) { return@Thread }
            }
        }.start()
    }

    private var watchGen = 0

    private fun failText(code: String): String = when (code) {
        "TELEPHONY_16" -> "The phone's modem refused to send this SMS (error 16). A SIM cannot text its own number, so this happens when the number is this phone's SIM (or the carrier blocks it). Tap \"Use a different number\" and enter another phone's number."
        "TELEPHONY_4", "TELEPHONY_9" -> "No mobile signal or SIM service, so the SMS could not be sent. Check your network, then tap Resend."
        "TELEPHONY_5" -> "The phone is sending too many SMS. Wait a few minutes, then tap Resend."
        "TELEPHONY_7", "TELEPHONY_8" -> "The carrier blocked this destination. Try another number."
        "DELIVERY_FAILED" -> "The carrier says the SMS was not delivered. Try another number, then tap Resend."
        else -> "The SMS could not be sent, so no code reached you. Check the connector, then tap Resend."
    }

    // ---------- step 3: calculator ----------
    private lateinit var resultView: TextView
    private lateinit var exprView: TextView
    private lateinit var clearBtn: TextView
    private val opButtons = HashMap<String, TextView>()

    private fun showCalculator() {
        tick?.let { ui.removeCallbacks(it) }
        root.removeAllViews()
        root.setBackgroundColor(Color.BLACK)
        val dm = resources.displayMetrics
        val gap = dp(12)
        val maxW = minOf(dm.widthPixels - dp(32), dp(420))
        var cell = (maxW - gap * 3) / 4
        val availH = dm.heightPixels - dp(150) // status bar + display area
        cell = minOf(cell, (availH * 0.62f / 5f).toInt() - gap)
        val gridW = cell * 4 + gap * 3

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; setPadding(0, dp(28), 0, dp(20)) }

        // display
        val disp = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.END }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(label("Verified ✓ $phone", 12f, Ui.ok).apply { }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(label("Done", 14f, Ui.muted).apply { setPadding(dp(12), dp(6), dp(4), dp(6)); isClickable = true; setOnClickListener { finish() } })
        disp.addView(top)
        exprView = label("", 18f, Color.argb(150, 255, 255, 255)).apply { gravity = Gravity.END; maxLines = 1; setPadding(0, dp(16), 0, 0) }
        disp.addView(exprView)
        resultView = label("0", 76f, Color.WHITE).apply {
            gravity = Gravity.END; maxLines = 1; setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(96))
            // swipe left/right on the number deletes the last digit, like iPhone
            var downX = 0f
            setOnTouchListener { v, ev ->
                if (ev.action == MotionEvent.ACTION_DOWN) downX = ev.x
                else if (ev.action == MotionEvent.ACTION_UP) {
                    if (Math.abs(ev.x - downX) > dp(40)) { engine.delete(); refresh() } else v.performClick()
                }
                true
            }
        }
        disp.addView(resultView)
        col.addView(disp, LinearLayout.LayoutParams(gridW, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })

        val dark = Color.parseColor("#333333"); val grey = Color.parseColor("#A5A5A5")
        fun btn(text: String, w: Int, fill: Int, fg: Int, action: () -> Unit) = TextView(this).apply {
            this.text = text; gravity = Gravity.CENTER; setTextColor(fg); setTextSize(TypedValue.COMPLEX_UNIT_PX, cell * 0.38f)
            isClickable = true; isSoundEffectsEnabled = true
            background = GradientDrawable().apply { setColor(fill); cornerRadius = cell / 2f }
            if (text == "0") gravity = Gravity.CENTER_VERTICAL or Gravity.START
            if (text == "0") setPadding((cell * 0.38f).toInt(), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(w, cell).apply { rightMargin = gap }
            setOnTouchListener { v, ev ->
                if (ev.action == MotionEvent.ACTION_DOWN) v.alpha = 0.7f
                else if (ev.action == MotionEvent.ACTION_UP || ev.action == MotionEvent.ACTION_CANCEL) v.alpha = 1f
                false
            }
            setOnClickListener { action(); refresh() }
        }
        fun row(vararg v: View) {
            val r = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            for ((i, x) in v.withIndex()) { r.addView(x); if (i == v.size - 1) (x.layoutParams as LinearLayout.LayoutParams).rightMargin = 0 }
            col.addView(r, LinearLayout.LayoutParams(gridW, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = gap })
        }
        val orange = Color.parseColor("#FF9F0A")
        fun op(sym: String) = btn(sym, cell, orange, Color.WHITE) { engine.operator(sym) }.also { opButtons[sym] = it }
        fun num(d: String) = btn(d, cell, dark, Color.WHITE) { engine.digit(d[0]) }

        clearBtn = btn("AC", cell, grey, Color.BLACK) { engine.clear() }
        row(clearBtn, btn("±", cell, grey, Color.BLACK) { engine.negate() }, btn("%", cell, grey, Color.BLACK) { engine.percent() }, op("÷"))
        row(num("7"), num("8"), num("9"), op("×"))
        row(num("4"), num("5"), num("6"), op("−"))
        row(num("1"), num("2"), num("3"), op("+"))
        row(btn("0", cell * 2 + gap, dark, Color.WHITE) { engine.digit('0') }, btn(".", cell, dark, Color.WHITE) { engine.dot() }, btn("=", cell, orange, Color.WHITE) { engine.calculate() })
        root.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        refresh()
    }

    private fun refresh() {
        val shown = engine.display()
        resultView.text = shown
        resultView.setTextSize(TypedValue.COMPLEX_UNIT_SP, when { shown.length > 14 -> 32f; shown.length > 11 -> 42f; shown.length > 8 -> 56f; else -> 76f })
        exprView.text = engine.expression()
        clearBtn.text = engine.clearLabel
        val active = engine.activeOperator
        for ((sym, b) in opButtons) {
            val on = sym == active
            (b.background as GradientDrawable).setColor(if (on) Color.WHITE else Color.parseColor("#FF9F0A"))
            b.setTextColor(if (on) Color.parseColor("#FF9F0A") else Color.WHITE)
        }
    }
}

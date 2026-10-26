package com.cwp.sms

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.UUID

/** Ready-made screen: status, Start/Stop, and a Send box. Glass-style, built in code (no resource files). */
class ConnectActivity : Activity() {
    private lateinit var runChip: TextView
    private lateinit var liveChip: TextView
    private lateinit var lineView: TextView
    private lateinit var sentView: TextView
    private lateinit var failedView: TextView
    private lateinit var toggle: TextView
    private lateinit var lastSmsView: TextView
    private lateinit var numberInput: EditText
    private lateinit var messageInput: EditText
    private lateinit var demoTab: TextView
    private lateinit var liveTab: TextView
    private lateinit var sendButton: TextView
    private lateinit var resultView: TextView
    private lateinit var content: LinearLayout
    private lateinit var panes: List<View>
    private lateinit var heroOrb: View
    private lateinit var heroTitle: TextView
    private var heroAnim: android.animation.ObjectAnimator? = null
    private var page = 0
    private var lastRunning: Boolean? = null
    private var lastLive: Boolean? = null
    private var liveChipSet = false
    private var liveMode = false
    private var idempotencyKey = UUID.randomUUID().toString()
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { render(); ui.postDelayed(this, 1000) }
    }

    private fun dp(v: Int) = Ui.dp(this, v)

    private fun label(text: String, sp: Float, color: Int = Ui.text, bold: Boolean = false) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun chip() = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(12), dp(5), dp(12), dp(5))
    }

    private fun styleChip(tv: TextView, text: String, color: Int) {
        tv.text = text
        tv.setTextColor(color)
        tv.background = Ui.tinted(this, color, 16)
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = Ui.glass(this@ConnectActivity)
        setPadding(dp(20), dp(20), dp(20), dp(20))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
    }

    private fun field(hint: String) = EditText(this).apply {
        this.hint = hint
        setHintTextColor(Ui.faint)
        setTextColor(Ui.text)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        background = Ui.glass(this@ConnectActivity, 16, true)
        setPadding(dp(16), dp(14), dp(16), dp(14))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
    }

    private fun button(text: String) = TextView(this).apply {
        this.text = text
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(16), dp(15), dp(16), dp(15))
        isClickable = true
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
    }

    /** Theme picker: each row shows that theme's own logo. Choosing one recolours the app and swaps the launcher icon. */
    private fun pickTheme() {
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(8), dp(16), dp(8)) }
        lateinit var dlg: AlertDialog
        for (t in Ui.themes) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8), dp(8), dp(8), dp(8))
                background = Ui.glass(this@ConnectActivity, 16, t.id == Ui.theme.id)
                setOnClickListener {
                    Ui.choose(this@ConnectActivity, t)
                    IconAlias.apply(this@ConnectActivity, t.id)
                    dlg.dismiss()
                    recreate()
                }
            }
            row.addView(LogoView(this, t.id), LinearLayout.LayoutParams(dp(44), dp(44)))
            val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0) }
            col.addView(label(t.name + if (t.id == Ui.theme.id) "  \u2713" else "", 16f, bold = true))
            col.addView(label(t.note, 12f, Ui.muted))
            row.addView(col)
            list.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
        }
        dlg = AlertDialog.Builder(this).setTitle("Theme").setView(ScrollView(this).apply { addView(list) }).setNegativeButton("Close", null).create()
        dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Ui.bgMid))
        dlg.show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Ui.load(this)
        title = "CWP SMS"
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Ui.bgTop
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN

        val root = FrameLayout(this).apply { background = Ui.background() }
        root.addView(Ui.orb(this, Ui.cyan, dp(320), -dp(120), -dp(60)))
        root.addView(Ui.orb(this, Ui.violet, dp(360), dp(120), dp(380)))

        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(28), dp(20), dp(120)) }

        // ---- header: logo + name ----
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(LogoView(this), LinearLayout.LayoutParams(dp(56), dp(56)))
        val names = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, 0, 0) }
        names.addView(label("CWP SMS", 24f, bold = true))
        names.addView(label("SIM gateway connector", 13f, Ui.muted))
        header.addView(names, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val themeBtn = TextView(this).apply {
            text = "Theme"; setTextColor(Ui.text); textSize = 12f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
            setPadding(dp(14), dp(8), dp(14), dp(8)); background = Ui.glass(this@ConnectActivity, 16, true)
            setOnClickListener { pickTheme() }
        }
        header.addView(themeBtn)
        content.addView(header)

        // ---- status card ----
        val status = card()
        val heroRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        heroOrb = View(this)
        heroRow.addView(heroOrb, LinearLayout.LayoutParams(dp(54), dp(54)))
        val heroText = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), 0, 0, 0) }
        heroTitle = label("Stopped", 26f, bold = true)
        heroText.addView(heroTitle)
        heroText.addView(label("Your SIM gateway", 13f, Ui.muted))
        heroRow.addView(heroText)
        status.addView(heroRow)
        val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(16), 0, 0) }
        runChip = chip(); liveChip = chip()
        chips.addView(runChip)
        chips.addView(liveChip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8) })
        status.addView(chips)
        lineView = label("", 15f, Ui.text).apply { setPadding(0, dp(14), 0, dp(4)) }
        status.addView(lineView)

        val stats = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, 0) }
        fun tile(caption: String, big: TextView, lastTile: Boolean) = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = Ui.glass(this@ConnectActivity, 16, true)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            addView(big); addView(label(caption, 12f, Ui.muted))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (!lastTile) rightMargin = dp(10) }
        }
        sentView = label("0", 26f, Ui.ok, true)
        failedView = label("0", 26f, Ui.bad, true)
        stats.addView(tile("Sent this session", sentView, false))
        stats.addView(tile("Failed", failedView, true))
        status.addView(stats)

        lastSmsView = label("", 13f, Ui.muted).apply { setPadding(0, dp(12), 0, 0) }
        status.addView(lastSmsView)
        toggle = button("Start connector")
        toggle.setOnClickListener { onToggle() }
        status.addView(toggle)
        val realTest = button("Start Real Test").apply {
            background = Ui.glass(this@ConnectActivity, 28, true)
            setOnClickListener { startActivity(android.content.Intent(this@ConnectActivity, RealTestActivity::class.java)) }
        }
        status.addView(realTest)
        status.addView(label("While running, a notification with a Stop button stays visible. Carrier SMS charges apply.", 12f, Ui.faint).apply { setPadding(0, dp(12), 0, 0) })
        val statusPane = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(status) }
        val sendPane = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        panes = listOf(statusPane, sendPane)
        content.addView(statusPane)

        // ---- send card ----
        val send = card()
        send.addView(label("Send a message", 18f, bold = true))
        send.addView(label("Creates a request on your CWP account. Live needs the connector running.", 13f, Ui.muted).apply { setPadding(0, dp(4), 0, 0) })
        numberInput = field("+919876543210").apply { inputType = InputType.TYPE_CLASS_PHONE }
        messageInput = field("Message").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE; minLines = 3; gravity = Gravity.TOP or Gravity.START }
        send.addView(numberInput); send.addView(messageInput)

        val seg = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = Ui.glass(this@ConnectActivity, 24, true)
            setPadding(dp(4), dp(4), dp(4), dp(4))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
        }
        fun tab(t: String) = TextView(this).apply {
            text = t; gravity = Gravity.CENTER; setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(8), dp(11), dp(8), dp(11)); isClickable = true
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        demoTab = tab("Demo · nothing sent"); liveTab = tab("Live · real SMS")
        demoTab.setOnClickListener { liveMode = false; renderTabs() }
        liveTab.setOnClickListener { liveMode = true; renderTabs() }
        seg.addView(demoTab); seg.addView(liveTab)
        send.addView(seg)

        sendButton = button("Send")
        sendButton.background = Ui.gradientButton(this, Ui.cyan, Ui.violet)
        sendButton.setOnClickListener { onSend() }
        send.addView(sendButton)
        resultView = label("", 13f, Ui.muted).apply { setPadding(0, dp(12), 0, 0) }
        send.addView(resultView)
        sendPane.addView(send)
        content.addView(sendPane)

        content.addView(label("CWP SMS · your SIM, your control", 12f, Ui.faint).apply { gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(24), 0, 0) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val scroll = ScrollView(this).apply { isFillViewport = true; addView(content) }
        root.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(buildDock(), dockParams)
        root.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            content.setPadding(dp(20), dp(28) + insets.systemWindowInsetTop, dp(20), dp(120) + insets.systemWindowInsetBottom)
            dockParams.bottomMargin = dp(18) + insets.systemWindowInsetBottom
            dock.layoutParams = dockParams
            insets
        }
        setContentView(root)
        renderTabs()
    }

    override fun onResume() { super.onResume(); ui.post(tick) }
    override fun onPause() { ui.removeCallbacks(tick); heroAnim?.cancel(); heroAnim = null; super.onPause() }

    private fun needed(): Array<String> {
        val list = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) list += Manifest.permission.SEND_SMS
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) list += Manifest.permission.POST_NOTIFICATIONS
        return list.toTypedArray()
    }

    private fun onToggle() {
        if (Status.running) { ConnectorService.stop(this); return }
        val missing = needed()
        if (missing.isNotEmpty()) requestPermissions(missing, 7) else ConnectorService.start(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED) ConnectorService.start(this)
    }

    private fun onSend() {
        val to = numberInput.text.toString().replace(Regex("[\\s-]"), "")
        val text = messageInput.text.toString()
        if (!Regex("^\\+[1-9]\\d{6,14}$").matches(to)) { resultView.text = "Enter the number with country code, like +919876543210."; return }
        if (text.isBlank()) { resultView.text = "Type a message."; return }
        if (liveMode && !Status.running) {
            resultView.text = "The connector is stopped. Tap Start connector first, otherwise a live message would just wait and expire."
            return
        }
        if (liveMode) {
            AlertDialog.Builder(this).setTitle("Send a real SMS?")
                .setMessage("A real SMS will be sent to $to from this phone's SIM. Your carrier may charge you.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Send") { _, _ -> doSend(to, text, true) }.show()
        } else doSend(to, text, false)
    }

    private fun doSend(to: String, text: String, live: Boolean) {
        sendButton.isEnabled = false
        sendButton.alpha = 0.6f
        resultView.text = "Sending request…"
        val key = idempotencyKey
        Thread {
            val line: String = try {
                val cred = Session.credential(this)
                val cfg = CwpSms.config(this)
                val r = Api(cfg.baseUrl).send(cred, to, text, if (live) "live" else "demo", key)
                idempotencyKey = UUID.randomUUID().toString()
                runOnUiThread { messageInput.setText("") }
                if (live) "Request created (${r.optString("id")}). The connector will send it; follow it in the dashboard."
                else "Demo recorded (${r.optString("id")}). Nothing was sent."
            } catch (e: ApiError) {
                when (e.code) {
                    "NO_ELIGIBLE_DEVICE" -> "No phone is online. Tap Start connector above, then try again."
                    "LIVE_SENDING_DISABLED" -> "Live sending is off for your account or the platform. Use Demo, or ask the administrator."
                    "RATE_LIMITED" -> "Too many requests. Wait a minute."
                    "QUOTA_EXCEEDED" -> "You have used today's SMS limit."
                    "DEVICE_REVOKED", "INVALID_DEVICE_CREDENTIAL" -> { Store(this).credential = null; "This phone was removed. Tap Send again to reconnect." }
                    else -> e.message ?: "Request failed (${e.code})."
                }
            } catch (e: Exception) {
                "Connection problem (${e.javaClass.simpleName}). Check your internet and try again."
            }
            runOnUiThread { resultView.text = line; sendButton.isEnabled = true; sendButton.alpha = 1f }
        }.start()
    }

    private lateinit var dock: FrameLayout
    private lateinit var lens: View
    private lateinit var dockTabs: List<TextView>
    private val dockParams by lazy {
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            leftMargin = dp(36); rightMargin = dp(36); bottomMargin = dp(18)
        }
    }

    /** A floating glass dock with a lens that glides between the two sections. */
    private fun buildDock(): View {
        dock = FrameLayout(this).apply {
            background = Ui.glass(this@ConnectActivity, 34, true)
            setPadding(dp(6), dp(6), dp(6), dp(6))
            elevation = dp(12).toFloat()
        }
        lens = View(this).apply { background = Ui.gradientButton(this@ConnectActivity, Ui.cyan, Ui.violet).apply { cornerRadius = Ui.dpf(this@ConnectActivity, 28f) } }
        dock.addView(lens, FrameLayout.LayoutParams(0, dp(50)))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun tab(t: String, i: Int) = TextView(this).apply {
            text = t; gravity = Gravity.CENTER; setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f); setTypeface(typeface, Typeface.BOLD)
            isClickable = true; setOnClickListener { selectPage(i) }
            layoutParams = LinearLayout.LayoutParams(0, dp(50), 1f)
        }
        dockTabs = listOf(tab("Connector", 0), tab("Send SMS", 1))
        dockTabs.forEach { row.addView(it) }
        dock.addView(row)
        dock.addOnLayoutChangeListener { _, l, _, r, _, _, _, _, _ ->
            val w = (r - l - dp(12)) / 2
            if (lens.layoutParams.width != w) { lens.layoutParams = (lens.layoutParams as FrameLayout.LayoutParams).apply { width = w }; lens.translationX = (page * w).toFloat() }
        }
        paintDock()
        return dock
    }

    private fun paintDock() {
        dockTabs.forEachIndexed { i, t -> t.setTextColor(if (i == page) Color.WHITE else Ui.muted) }
    }

    private fun selectPage(i: Int) {
        if (i == page) return
        val from = panes[page]; val to = panes[i]
        page = i; paintDock()
        android.animation.ObjectAnimator.ofFloat(lens, View.TRANSLATION_X, (i * lens.layoutParams.width).toFloat()).apply {
            duration = 300; interpolator = android.view.animation.OvershootInterpolator(0.9f); start()
        }
        lens.animate().scaleX(1.1f).scaleY(1.08f).setDuration(110).withEndAction { lens.animate().scaleX(1f).scaleY(1f).setDuration(200).start() }.start()
        // Swap at once: the old section leaves immediately and the new one slides in, so there is no wait.
        from.animate().cancel(); to.animate().cancel()
        from.visibility = View.GONE; from.alpha = 1f; from.translationY = 0f
        to.alpha = 0f; to.translationY = dp(12).toFloat(); to.visibility = View.VISIBLE
        to.animate().alpha(1f).translationY(0f).setDuration(200).setInterpolator(android.view.animation.DecelerateInterpolator()).start()
    }

    private fun renderTabs() {
        val on = Ui.gradientButton(this, Ui.cyan, Ui.violet).apply { cornerRadius = Ui.dpf(this@ConnectActivity, 20f) }
        demoTab.background = if (!liveMode) on else null
        liveTab.background = if (liveMode) on else null
        demoTab.setTextColor(if (!liveMode) Color.WHITE else Ui.muted)
        liveTab.setTextColor(if (liveMode) Color.WHITE else Ui.muted)
        sendButton.text = if (liveMode) "Send real SMS" else "Send demo"
    }

    private fun render() {
        val running = Status.running
        heroTitle.text = if (running) "Running" else "Stopped"
        if (lastRunning != running) {
            lastRunning = running
            heroOrb.background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                colors = intArrayOf(if (running) Ui.ok else Ui.muted, if (running) Color.parseColor("#4FB848") else Color.argb(90, 255, 255, 255))
                setStroke(Ui.dp(this@ConnectActivity, 3), Color.argb(120, 255, 255, 255))
            }
            toggle.background = if (running) Ui.gradientButton(this, Color.parseColor("#FF6B6B"), Color.parseColor("#D6294A"))
            else Ui.gradientButton(this, Ui.cyan, Ui.violet)
            styleChip(runChip, if (running) "● RUNNING" else "● STOPPED", if (running) Ui.ok else Ui.muted)
        }
        if (lastLive != Status.liveAllowed || !liveChipSet) {
            lastLive = Status.liveAllowed; liveChipSet = true
            when (Status.liveAllowed) {
                true -> styleChip(liveChip, "LIVE ON", Ui.cyan)
                false -> styleChip(liveChip, "LIVE OFF", Ui.warn)
                null -> styleChip(liveChip, "LIVE ?", Ui.muted)
            }
        }
        if (running && heroAnim == null) {
            heroAnim = android.animation.ObjectAnimator.ofPropertyValuesHolder(heroOrb,
                android.animation.PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.14f), android.animation.PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.14f),
                android.animation.PropertyValuesHolder.ofFloat(View.ALPHA, 1f, .75f)).apply { duration = 900; repeatCount = android.animation.ValueAnimator.INFINITE; repeatMode = android.animation.ValueAnimator.REVERSE; start() }
        } else if (!running && heroAnim != null) { heroAnim?.cancel(); heroAnim = null; heroOrb.scaleX = 1f; heroOrb.scaleY = 1f; heroOrb.alpha = 1f }
        val blocked = if (Status.blockedBy.isEmpty()) "" else "\nLive is off: " + Status.blockedBy.joinToString { if (it == "account_flag") "your account is not enabled yet" else "platform setting" }
        setIf(lineView, Status.line + blocked)
        setIf(lastSmsView, if (Status.lastSms.isEmpty()) "" else "Last SMS: " + Status.lastSms)
        val vis = if (Status.lastSms.isEmpty()) View.GONE else View.VISIBLE
        if (lastSmsView.visibility != vis) lastSmsView.visibility = vis
        setIf(sentView, Status.sentThisSession.toString())
        setIf(failedView, Status.failedThisSession.toString())
        setIf(toggle, if (running) "Stop connector" else "Start connector")
    }

    /** Skip no-op updates so the once-a-second refresh never triggers a layout pass. */
    private fun setIf(tv: TextView, value: String) { if (tv.text.toString() != value) tv.text = value }
}

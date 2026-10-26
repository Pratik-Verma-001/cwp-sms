package com.cwp.sms

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.FrameLayout

/** Small, dependency-free helpers for the glass look. */
internal data class Theme(val id: String, val name: String, val note: String, val c1: Int, val c2: Int, val bgTop: Int, val bgMid: Int, val bgBottom: Int)

internal object Ui {
    private fun hex(v: String) = Color.parseColor(v)
    val themes = listOf(
        Theme("ember", "Ember", "Coral and magenta", hex("#FF9A62"), hex("#FF2D87"), hex("#0C050F"), hex("#1E0A22"), hex("#2B0E18")),
        Theme("aurora", "Aurora", "Teal and emerald", hex("#14B8A6"), hex("#22C55E"), hex("#03100D"), hex("#062A22"), hex("#0A2A1C")),
        Theme("solar", "Solar", "Amber and flame", hex("#F59E0B"), hex("#EA580C"), hex("#120A02"), hex("#2A1604"), hex("#2E0F06")),
        Theme("orchid", "Orchid", "Violet and rose", hex("#A78BFA"), hex("#F472B6"), hex("#0D0720"), hex("#1D0F3D"), hex("#2D0F3A")),
        Theme("ocean", "Ocean", "Sky and indigo", hex("#38BDF8"), hex("#6366F1"), hex("#040B1C"), hex("#0B1B3F"), hex("#06283A")),
        Theme("graphite", "Graphite", "Steel and slate", hex("#8B8B96"), hex("#52525B"), hex("#060607"), hex("#131316"), hex("#0C0C10")),
    )
    var theme: Theme = themes[0]
        private set

    /** Reads the saved theme. Call once before building any screen. */
    fun load(c: Context) {
        val id = c.applicationContext.getSharedPreferences("cwp_ui", Context.MODE_PRIVATE).getString("theme", "ember")
        apply(themes.firstOrNull { it.id == id } ?: themes[0])
    }

    fun choose(c: Context, t: Theme) {
        c.applicationContext.getSharedPreferences("cwp_ui", Context.MODE_PRIVATE).edit().putString("theme", t.id).apply()
        apply(t)
    }

    private fun apply(t: Theme) {
        theme = t; bgTop = t.bgTop; bgMid = t.bgMid; bgBottom = t.bgBottom; cyan = t.c1; violet = t.c2
    }

    var bgTop = Color.parseColor("#000000")
    var bgMid = Color.parseColor("#000000")
    var bgBottom = Color.parseColor("#000000")
    var cyan = Color.parseColor("#000000")
    var violet = Color.parseColor("#000000")
    val ok = Color.parseColor("#B9F56A")
    val warn = Color.parseColor("#FFD36E")
    val bad = Color.parseColor("#FF6B6B")
    val text = Color.WHITE
    val muted = Color.argb(170, 255, 255, 255)
    val faint = Color.argb(110, 255, 255, 255)

    fun dp(c: Context, v: Int) = (v * c.resources.displayMetrics.density).toInt()
    fun dpf(c: Context, v: Float) = v * c.resources.displayMetrics.density

    fun background(): GradientDrawable =
        GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(bgTop, bgMid, bgBottom))

    /** Frosted card: translucent white gradient with a hairline highlight border. */
    fun glass(c: Context, radius: Int = 24, strong: Boolean = false): GradientDrawable =
        GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            if (strong) intArrayOf(Color.argb(60, 255, 255, 255), Color.argb(26, 255, 255, 255))
            else intArrayOf(Color.argb(46, 255, 255, 255), Color.argb(16, 255, 255, 255)),
        ).apply {
            cornerRadius = dpf(c, radius.toFloat())
            setStroke(dp(c, 1), Color.argb(70, 255, 255, 255))
        }

    fun gradientButton(c: Context, from: Int, to: Int): GradientDrawable =
        GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(from, to)).apply { cornerRadius = dpf(c, 28f) }

    fun tinted(c: Context, color: Int, radius: Int = 20): GradientDrawable =
        GradientDrawable().apply {
            setColor(Color.argb(46, Color.red(color), Color.green(color), Color.blue(color)))
            setStroke(dp(c, 1), Color.argb(150, Color.red(color), Color.green(color), Color.blue(color)))
            cornerRadius = dpf(c, radius.toFloat())
        }

    /** Soft glowing blob used behind the cards; blurred for real on Android 12+. */
    fun orb(c: Context, color: Int, size: Int, x: Int, y: Int): View = View(c).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            gradientType = GradientDrawable.RADIAL_GRADIENT
            gradientRadius = size / 2f
            colors = intArrayOf(Color.argb(150, Color.red(color), Color.green(color), Color.blue(color)), Color.TRANSPARENT)
        }
        layoutParams = FrameLayout.LayoutParams(size, size).apply { leftMargin = x; topMargin = y }
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            setRenderEffect(android.graphics.RenderEffect.createBlurEffect(50f, 50f, android.graphics.Shader.TileMode.CLAMP))
        }
    }
}

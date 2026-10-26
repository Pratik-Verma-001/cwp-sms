package com.cwp.sms

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.view.View

/**
 * The CWP mark. Every theme has its own design, not just its own colours:
 * Ember = SIM-cut chat bubble, Aurora = signal waves, Solar = sun, Orchid = sparkle, Ocean = paper plane, Graphite = monogram.
 * Drawn in code (64x64 units), so it needs no image files.
 */
internal class LogoView(context: Context, private val themeId: String? = null) : View(context) {
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val white = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(245, 255, 255, 255); style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val tint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val gloss = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bubble = Path().apply {
        moveTo(20f, 14f); lineTo(38f, 14f); lineTo(48f, 24f); lineTo(48f, 42f)
        quadTo(48f, 46f, 44f, 46f); lineTo(30f, 46f); lineTo(22f, 53f); lineTo(22f, 46f); lineTo(20f, 46f)
        quadTo(16f, 46f, 16f, 42f); lineTo(16f, 18f); quadTo(16f, 14f, 20f, 14f); close()
    }

    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    private fun shape(c: Canvas, p: Path, width: Float) {
        bg.style = Paint.Style.FILL_AND_STROKE; bg.strokeWidth = width; bg.strokeJoin = Paint.Join.ROUND
        c.drawPath(p, bg); bg.style = Paint.Style.FILL; bg.strokeWidth = 0f
    }

    override fun onDraw(c: Canvas) {
        val t = Ui.themes.firstOrNull { it.id == themeId } ?: Ui.theme
        val s = width / 64f
        c.save(); c.scale(s, s)
        bg.shader = if (t.c3 != 0) LinearGradient(0f, 0f, 64f, 64f, intArrayOf(t.c1, t.c2, t.c3), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
                    else LinearGradient(0f, 0f, 64f, 64f, t.c1, t.c2, Shader.TileMode.CLAMP)
        gloss.shader = LinearGradient(0f, 0f, 0f, 32f, Color.argb(100, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        when (t.id) {
            "aurora" -> {
                c.drawCircle(32f, 32f, 32f, bg); c.drawCircle(32f, 32f, 32f, gloss)
                stroke.strokeWidth = 4.2f; stroke.alpha = 255
                c.drawArc(RectF(16f, 31.6f, 48f, 63.6f), 221.4f, 97.2f, false, stroke)
                stroke.alpha = 180
                c.drawArc(RectF(4f, 19.6f, 60f, 75.6f), 224.4f, 91.2f, false, stroke)
                c.drawCircle(32f, 45f, 4.8f, white)
            }
            "solar" -> {
                shape(c, Path().apply { moveTo(32f, 9f); lineTo(55f, 32f); lineTo(32f, 55f); lineTo(9f, 32f); close() }, 14f)
                c.drawCircle(32f, 32f, 8.5f, white)
                stroke.strokeWidth = 3.2f; stroke.alpha = 255
                for (k in 0 until 8) {
                    val a = k * Math.PI / 4
                    c.drawLine((32 + Math.cos(a) * 14).toFloat(), (32 + Math.sin(a) * 14).toFloat(), (32 + Math.cos(a) * 19.5).toFloat(), (32 + Math.sin(a) * 19.5).toFloat(), stroke)
                }
            }
            "orchid" -> {
                shape(c, Path().apply { moveTo(32f, 8f); lineTo(54f, 20.5f); lineTo(54f, 45.5f); lineTo(32f, 58f); lineTo(10f, 45.5f); lineTo(10f, 20.5f); close() }, 10f)
                c.drawPath(Path().apply {
                    moveTo(32f, 15f); lineTo(37.5f, 27f); lineTo(50f, 32f); lineTo(37.5f, 37f); lineTo(32f, 49f); lineTo(26.5f, 37f); lineTo(14f, 32f); lineTo(26.5f, 27f); close()
                }, white)
                tint.color = t.c2; c.drawCircle(32f, 32f, 3f, tint)
            }
            "ocean" -> {
                c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 22f, 22f, bg); c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 22f, 22f, gloss)
                c.drawPath(Path().apply { moveTo(14f, 29f); lineTo(51f, 13f); lineTo(39f, 49f); lineTo(30f, 36f); close() }, white)
                stroke.strokeWidth = 2f; stroke.color = Color.argb(140, Color.red(t.c2), Color.green(t.c2), Color.blue(t.c2))
                c.drawLine(30f, 36f, 51f, 13f, stroke)
                stroke.color = Color.WHITE; stroke.strokeWidth = 2.6f; stroke.alpha = 165
                val wave = Path().apply { moveTo(12f, 54f); for (i in 0 until 4) { val x0 = 12f + 10f * i; quadTo(x0 + 5f, if (i % 2 == 0) 49f else 59f, x0 + 10f, 54f) } }
                c.drawPath(wave, stroke)
            }
            "graphite" -> {
                c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 16f, 16f, bg)
                stroke.strokeWidth = 1.5f; stroke.alpha = 70
                c.drawRoundRect(RectF(2.5f, 2.5f, 61.5f, 61.5f), 14f, 14f, stroke)
                stroke.strokeWidth = 6.4f; stroke.alpha = 255
                c.drawArc(RectF(19.2f, 18f, 47.2f, 46f), 45.6f, 268.8f, false, stroke)
                c.drawCircle(47f, 32f, 3.2f, white)
            }
            "neon" -> {
                c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 20f, 20f, bg); c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 20f, 20f, gloss)
                val bolt = Path().apply { moveTo(37f, 9f); lineTo(17f, 36f); lineTo(30f, 36f); lineTo(26f, 55f); lineTo(47f, 26f); lineTo(34f, 26f); close() }
                stroke.style = Paint.Style.FILL_AND_STROKE; stroke.strokeWidth = 2f; stroke.alpha = 255
                c.drawPath(bolt, stroke); stroke.style = Paint.Style.STROKE
            }
            "sunset" -> {
                c.drawCircle(32f, 32f, 32f, bg); c.drawCircle(32f, 32f, 32f, gloss)
                c.drawPath(Path().apply { moveTo(20f, 36f); arcTo(RectF(20f, 24f, 44f, 48f), 180f, 180f); close() }, white)
                stroke.strokeWidth = 3f
                stroke.alpha = 255; c.drawLine(17f, 41.5f, 47f, 41.5f, stroke)
                stroke.alpha = 204; c.drawLine(22f, 47f, 42f, 47f, stroke)
                stroke.alpha = 153; c.drawLine(27f, 52.5f, 37f, 52.5f, stroke)
            }
            "crimson" -> {
                c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 20f, 20f, bg); c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 20f, 20f, gloss)
                val heart = Path().apply {
                    moveTo(32f, 49f); cubicTo(19f, 40.5f, 14f, 33.5f, 14f, 26.5f)
                    cubicTo(14f, 17f, 27f, 14f, 32f, 22.5f); cubicTo(37f, 14f, 50f, 17f, 50f, 26.5f)
                    cubicTo(50f, 33.5f, 45f, 40.5f, 32f, 49f); close()
                }
                c.drawPath(heart, white)
                stroke.strokeWidth = 2.4f; stroke.color = t.c1; stroke.alpha = 255
                c.drawArc(RectF(18.5f, 18.5f, 27.5f, 27.5f), 180f, 90f, false, stroke)
                stroke.color = Color.WHITE
            }
            "mocha" -> {
                c.drawCircle(32f, 32f, 32f, bg); c.drawCircle(32f, 32f, 32f, gloss)
                c.drawPath(Path().apply { moveTo(19f, 28f); lineTo(43f, 28f); lineTo(43f, 40f); quadTo(43f, 49f, 34f, 49f); lineTo(28f, 49f); quadTo(19f, 49f, 19f, 40f); close() }, white)
                stroke.strokeWidth = 3.2f; stroke.alpha = 255
                c.drawPath(Path().apply { moveTo(43f, 31f); lineTo(46f, 31f); arcTo(RectF(41f, 31f, 51f, 41f), -90f, 180f); lineTo(42.5f, 41f) }, stroke)
                stroke.strokeWidth = 2.4f; stroke.alpha = 190
                for (x in floatArrayOf(26f, 32f, 38f)) c.drawPath(Path().apply { moveTo(x, 22f); quadTo(x - 2f, 19f, x, 15.5f) }, stroke)
            }
            else -> { // ember: gradient squircle, gloss, bubble with a cut corner, gradient dots and a sparkle
                c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 18f, 18f, bg); c.drawRoundRect(RectF(0f, 0f, 64f, 64f), 18f, 18f, gloss)
                white.setShadowLayer(3f, 0f, 1.5f, Color.argb(90, 20, 10, 80))
                c.drawPath(bubble, white)
                white.clearShadowLayer()
                tint.color = Color.argb(100, Color.red(t.c2), Color.green(t.c2), Color.blue(t.c2))
                c.drawPath(Path().apply { moveTo(38f, 14f); lineTo(48f, 24f); lineTo(38f, 24f); close() }, tint)
                val dots = Paint(Paint.ANTI_ALIAS_FLAG)
                val cols = intArrayOf(t.c1, t.c2, t.c3)
                for ((k, x) in floatArrayOf(25.5f, 32f, 38.5f).withIndex()) { dots.color = cols[k]; c.drawCircle(x, 30f, 2.7f, dots) }
                c.drawPath(Path().apply { moveTo(52f, 8f); lineTo(53.8f, 13.2f); lineTo(59f, 15f); lineTo(53.8f, 16.8f); lineTo(52f, 22f); lineTo(50.2f, 16.8f); lineTo(45f, 15f); lineTo(50.2f, 13.2f); close() }, white)
            }
        }
        c.restore()
    }

    override fun onMeasure(w: Int, h: Int) {
        val size = MeasureSpec.getSize(w).takeIf { MeasureSpec.getMode(w) != MeasureSpec.UNSPECIFIED } ?: 0
        val d = if (size > 0) size else (56 * resources.displayMetrics.density).toInt()
        setMeasuredDimension(d, d)
    }
}

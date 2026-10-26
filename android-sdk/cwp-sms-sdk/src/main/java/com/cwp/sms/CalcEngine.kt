package com.cwp.sms

import java.math.BigDecimal
import java.math.MathContext

/**
 * iPhone-style calculator logic with real operator precedence (x and / bind tighter than + and -).
 * Pure Kotlin, no Android classes. Numbers are BigDecimal, so 0.1 + 0.2 is exactly 0.3.
 */
internal class CalcEngine {
    private val tokens = ArrayList<String>()   // numbers and operators typed so far, e.g. ["2", "+", "3", "x"]
    private var entry = "0"                    // the number being typed (or the last result)
    private var entryActive = true             // false right after an operator is pressed
    private var justEvaluated = false
    private var error = false

    private val mc = MathContext(12)
    private val maxDigits = 12

    val isError get() = error
    /** "C" while a number is being typed, otherwise "AC". */
    val clearLabel get() = if (!error && entryActive && entry != "0" && !justEvaluated) "C" else "AC"
    val activeOperator: String? get() = if (!entryActive && tokens.isNotEmpty()) tokens.last() else null

    fun display(): String = if (error) "Error" else group(entry)

    /** The pending expression shown small above the result, e.g. "2 + 3 x". */
    fun expression(): String = tokens.joinToString(" ")

    fun digit(d: Char) {
        if (error) reset()
        if (justEvaluated || !entryActive) { entry = "0"; entryActive = true; justEvaluated = false }
        val digits = entry.count { it.isDigit() }
        if (entry == "0") entry = d.toString()
        else if (entry == "-0") entry = "-$d"
        else if (digits < maxDigits) entry += d
    }

    fun dot() {
        if (error) reset()
        if (justEvaluated || !entryActive) { entry = "0"; entryActive = true; justEvaluated = false }
        if (!entry.contains('.')) entry += "."
    }

    fun operator(op: String) {
        if (error) return
        if (!entryActive && tokens.isNotEmpty()) { tokens[tokens.size - 1] = op; return } // change your mind: replace
        tokens.add(clean(entry)); tokens.add(op)
        entryActive = false; justEvaluated = false
    }

    fun negate() {
        if (error) return
        if (!entryActive) { entry = "0"; entryActive = true } // "5 + (-)" starts a negative number
        entry = if (entry.startsWith("-")) entry.substring(1) else if (entry == "0" && !justEvaluated) "-0" else "-$entry"
        justEvaluated = false
    }

    /** "50 +10 %" means 10% of 50 (as on iPhone); otherwise the number is divided by 100. */
    fun percent() {
        if (error) return
        val v = parse(entry)
        val res = if (tokens.size >= 2 && entryActive && (tokens[tokens.size - 1] == "+" || tokens[tokens.size - 1] == "-")) {
            parse(tokens[tokens.size - 2]).multiply(v).divide(BigDecimal(100), mc)
        } else v.divide(BigDecimal(100), mc)
        entry = format(res); entryActive = true; justEvaluated = false
    }

    /** Delete the last typed character. */
    fun delete() {
        if (error) { reset(); return }
        if (!entryActive || justEvaluated) return
        entry = entry.dropLast(1)
        if (entry.isEmpty() || entry == "-") entry = "0"
    }

    fun clear() {
        if (clearLabel == "C") { entry = "0" } else reset()
    }

    fun calculate() {
        if (error) return
        if (tokens.isEmpty()) { entry = clean(entry); justEvaluated = true; return }
        val all = ArrayList(tokens)
        if (entryActive) all.add(clean(entry)) else all.removeAt(all.size - 1) // trailing operator: ignore it
        tokens.clear()
        try {
            entry = format(evaluate(all))
        } catch (e: ArithmeticException) {
            error = true; entry = "0"
        }
        entryActive = true; justEvaluated = true
    }

    private fun reset() { tokens.clear(); entry = "0"; entryActive = true; justEvaluated = false; error = false }

    private fun clean(s: String): String {
        var t = s
        if (t.endsWith(".")) t = t.dropLast(1)
        if (t == "-0" || t == "-") t = "0"
        return t.ifEmpty { "0" }
    }

    private fun parse(s: String): BigDecimal = BigDecimal(clean(s))

    /** Two passes: x and / first, then + and -. Throws ArithmeticException on division by zero. */
    private fun evaluate(t: List<String>): BigDecimal {
        val nums = ArrayList<BigDecimal>(); val ops = ArrayList<String>()
        nums.add(parse(t[0]))
        var i = 1
        while (i < t.size) {
            val op = t[i]; val n = parse(t[i + 1]); i += 2
            if (op == "x" || op == "×") nums[nums.size - 1] = nums.last().multiply(n, mc)
            else if (op == "/" || op == "÷") nums[nums.size - 1] = nums.last().divide(n, mc) // n == 0 throws
            else { ops.add(op); nums.add(n) }
        }
        var r = nums[0]
        for (k in ops.indices) r = if (ops[k] == "+") r.add(nums[k + 1]) else r.subtract(nums[k + 1])
        return r
    }

    private fun format(v: BigDecimal): String {
        val r = v.round(mc)
        val s = if (r.signum() == 0) "0" else r.stripTrailingZeros().let { if (it.scale() < 0 && it.precision() - it.scale() <= 15) it.toPlainString() else it.toString() }
        return s
    }

    private fun group(s: String): String {
        if (s.contains('E')) return s
        val neg = s.startsWith("-")
        val body = if (neg) s.substring(1) else s
        val dot = body.indexOf('.')
        val int = if (dot >= 0) body.substring(0, dot) else body
        val frac = if (dot >= 0) body.substring(dot) else ""
        val grouped = int.reversed().chunked(3).joinToString(",").reversed()
        return (if (neg) "-" else "") + grouped + frac
    }
}

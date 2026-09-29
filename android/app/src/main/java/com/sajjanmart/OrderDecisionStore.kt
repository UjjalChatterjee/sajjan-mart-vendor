package com.sajjanmart

import android.content.Context
import android.util.Log

/**
 * Native memory of orders this device has already resolved.
 *
 * A decision is confirmed by either:
 *   - the backend answering 2xx / 409 for this device's Accept or Reject call, or
 *   - an ORDER_STATUS_UPDATED push, which is the backend announcing the decision.
 *
 * Why it exists: the background/killed alert path runs entirely in native code,
 * with no React Native runtime to ask. Without this record, a NEW_ORDER push
 * that lands after the decision — a delivery retry, or simply the status push
 * winning the race — would start the looping siren and re-post the notification
 * for an order that is already handled.
 *
 * Bounded FIFO in SharedPreferences. Order ids are opaque store identifiers and
 * must never collide with the separator.
 */
object OrderDecisionStore {
    private const val TAG = "OrderDecisionStore"
    private const val PREFS_NAME = "sajjanmart_order_decisions"
    private const val KEY_RESOLVED = "resolved_order_ids"
    private const val LIMIT = 100
    private const val SEPARATOR = "\u0001"

    fun markResolved(context: Context, orderId: String) {
        if (orderId.isBlank() || orderId == "unknown") return

        val current = read(context)
        if (current.contains(orderId)) return

        val next = (current + orderId).takeLast(LIMIT)
        prefs(context).edit()
            .putString(KEY_RESOLVED, next.joinToString(SEPARATOR))
            .apply()
        Log.d(TAG, "[ORDER-ALERT] Order recorded as resolved: $orderId")
    }

    fun isResolved(context: Context, orderId: String): Boolean {
        if (orderId.isBlank() || orderId == "unknown") return false
        return read(context).contains(orderId)
    }

    private fun read(context: Context): List<String> =
        prefs(context)
            .getString(KEY_RESOLVED, "")
            .orEmpty()
            .split(SEPARATOR)
            .filter { it.isNotBlank() }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}

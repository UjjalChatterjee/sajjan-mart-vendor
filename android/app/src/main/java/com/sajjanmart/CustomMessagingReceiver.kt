package com.sajjanmart

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import io.invertase.firebase.common.SharedUtils
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver

/**
 * Custom FCM BroadcastReceiver that intercepts order messages
 * and handles them purely in native Android for background/killed states.
 *
 * Requirements:
 *   - For FCM messages where data.type == "NEW_ORDER":
 *     - If app is backgrounded or completely killed:
 *         1. Handle entirely in native Android.
 *         2. Do NOT depend on React Native JS (never dispatch to super / HeadlessJsTask).
 *         3. Start OrderAlertService passing the complete order data — unless this
 *            device already resolved that order, in which case it must stay silent.
 *         4. Create exactly one custom notification (managed by OrderAlertService),
 *            keyed to the order so it can be cancelled on its own.
 *     - If app is in foreground:
 *         Do not change existing foreground popup behavior (delegate to super for JS modal).
 *   - For data.type == "ORDER_STATUS_UPDATED":
 *       Another device (or this one) decided the order. Stop the siren and cancel
 *       ONLY that order's notification natively — the JS runtime may never run —
 *       then delegate to super so the live app can close its modal and cache too.
 *   - For all other message types:
 *     Delegate to super for normal library handling.
 */
class CustomMessagingReceiver : ReactNativeFirebaseMessagingReceiver() {

    companion object {
        private const val TAG = "CustomMessagingReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            val extras = intent.extras
            val remoteMessage = if (extras != null) RemoteMessage(extras) else null
            val data = remoteMessage?.data ?: emptyMap()

            // Helper to get field from data map or bundle extras with fallbacks
            fun getField(vararg keys: String): String? {
                for (key in keys) {
                    val fromData = data[key]
                    if (!fromData.isNullOrBlank()) return fromData
                    val fromExtras = extras?.getString(key)
                    if (!fromExtras.isNullOrBlank()) return fromExtras
                }
                return null
            }

            // eventType is the multi-device field; type stays for installed builds.
            val type = getField("eventType", "type", "data.type")

            if (type == "ORDER_STATUS_UPDATED") {
                val orderId = getField("orderId", "order_id", "id") ?: return
                val status = getField("status", "decision") ?: ""
                Log.d(TAG, "[ORDER-ALERT] ORDER_STATUS_UPDATED for order $orderId → $status")

                // Remembered so a NEW_ORDER that lands later (out-of-order delivery)
                // can never re-start the alert for an order that is already decided.
                OrderDecisionStore.markResolved(context, orderId)

                // Native cleanup first: no JS dependency in background/killed.
                OrderAlertService.handleOrderResolved(context, orderId)

                // Fall through to super so a live JS runtime closes its modal and
                // updates the query cache as well.
            } else if (type == "NEW_ORDER") {
                val isForeground = isAppInForeground(context)
                Log.d(TAG, "[FCM] NEW_ORDER received. isForeground=$isForeground")

                if (!isForeground) {
                    // App is backgrounded or completely killed:
                    // Pure native Android handling — NO React Native JS dependency.
                    val orderId = getField("orderId", "order_id", "id") ?: "unknown"

                    if (OrderDecisionStore.isResolved(context, orderId)) {
                        Log.d(TAG, "[ORDER-ALERT] Order $orderId already resolved — stale NEW_ORDER dropped")
                        return
                    }

                    val orderNumber = getField("orderNumber", "order_number") ?: orderId
                    val customerName = getField("customerName", "customer_name") ?: ""
                    val customerPhone = getField("customerPhone", "customer_phone") ?: ""
                    val address = getField("address") ?: ""
                    val total = getField("total") ?: ""
                    val paymentMethod = getField("paymentMethod", "payment_method") ?: ""
                    val paymentStatus = getField("paymentStatus", "payment_status") ?: ""
                    val itemsJson = getField("items", "itemsJson", "items_json") ?: "[]"
                    val itemCount = getField("itemCount", "item_count") ?: ""

                    Log.d(TAG, "[FCM] App not in foreground — starting native OrderAlertService")
                    Log.d(TAG, "[ORDER-ALERT] starting for order: $orderId (#$orderNumber)")

                    // Start native OrderAlertService with complete order payload.
                    // The notification id is derived from orderId, so a repeat
                    // delivery of the same order replaces its own notification
                    // instead of stacking a duplicate — no global cancellation
                    // of unrelated notifications is needed.
                    OrderAlertService.start(
                        context = context,
                        orderId = orderId,
                        orderNumber = orderNumber,
                        customerName = customerName,
                        customerPhone = customerPhone,
                        address = address,
                        total = total,
                        paymentMethod = paymentMethod,
                        paymentStatus = paymentStatus,
                        itemsJson = itemsJson,
                        itemCount = itemCount,
                    )

                    // CRITICAL: Return immediately!
                    // Do NOT call super.onReceive() in background/killed state for NEW_ORDER.
                    // Calling super would start ReactNativeFirebaseMessagingHeadlessService,
                    // spinning up the JS runtime and running setBackgroundMessageHandler,
                    // which violates "do not depend on React Native JS" and can cause duplicate notifications.
                    return
                } else {
                    Log.d(TAG, "[FCM] App in foreground — delegating to super for JS popup")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error processing FCM message in CustomMessagingReceiver", e)
        }

        // Delegate to super for:
        // 1. Foreground NEW_ORDER (fires onMessage in JS for in-app popup modal)
        // 2. ORDER_STATUS_UPDATED (fires onMessage / background handler in JS)
        // 3. All other message types, token refreshes, etc.
        super.onReceive(context, intent)
    }

    /**
     * Check if the app is in the foreground.
     * Uses SharedUtils.isAppInForeground from @react-native-firebase with
     * fallback to ActivityManager process importance check.
     */
    private fun isAppInForeground(context: Context): Boolean {
        try {
            if (SharedUtils.isAppInForeground(context)) {
                return true
            }
        } catch (e: Exception) {
            Log.w(TAG, "SharedUtils foreground check failed, falling back to ActivityManager", e)
        }

        try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            val procs = am?.runningAppProcesses ?: return false
            for (proc in procs) {
                if (proc.processName == context.packageName) {
                    return proc.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking ActivityManager foreground state", e)
        }
        return false
    }
}


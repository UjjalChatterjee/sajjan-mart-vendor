package com.sajjanmart

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receives ACCEPT / REJECT action intents from notification buttons.
 *
 * Responsibilities (in order, with 0ms latency goals):
 *   1. Receive the action in native Android (no JS runtime needed).
 *   2. Extract orderId (and orderNumber for user-facing messages).
 *   3. Stop the looping alert sound immediately via OrderAlertService.stop().
 *   4. Remove the order notification (and any prior feedback notification).
 *   5a. If JS runtime is alive → emit event via NotificationHelperModule so
 *       OrdersScreen can handle it (update UI, show toast, invalidate query).
 *   5b. If JS runtime is dead (killed/background) → start NativeOrderApiService
 *       which calls PUT /api/orders/{id} directly without React Native.
 *   6. Handle API success and failure safely (NativeOrderApiService shows
 *      a feedback notification on failure).
 *   7. Never require the user to open the app first.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "NotificationActionReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // 2. Extract orderId — try multiple extras for robustness
        val orderId = intent.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID)
            ?: intent.getStringExtra("orderId")
            ?: intent.getStringExtra("order_id")
            ?: return

        val orderNumber = intent.getStringExtra("orderNumber") ?: orderId

        val action = intent.getStringExtra(NotificationHelperModule.EXTRA_ACTION)
            ?: intent.action
            ?: return

        val actionName = when (action) {
            NotificationHelperModule.ACTION_ACCEPT -> "ACCEPT"
            NotificationHelperModule.ACTION_REJECT -> "REJECT"
            else -> action
        }

        Log.d(TAG, "[ORDER-ACTION] $actionName tapped for order $orderId")

        // 3. Stop looping alert sound immediately (0ms latency via singleton)
        OrderAlertService.stop(context)
        Log.d(TAG, "[ORDER-ALERT] Sound stopped")

        // 4. Remove order notification and any prior API-failure feedback notification
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(OrderAlertService.NOTIFICATION_ID)            // service foreground notif
            nm.cancel(0x7FFFFFFF and orderId.hashCode())            // per-order notif from JS module
            nm.cancel(0x4F524445)                                   // FEEDBACK_NOTIF_ID from NativeOrderApiService
            CustomMessagingReceiver.suppressDuplicateNotifications(context)
            Log.d(TAG, "[ORDER-ALERT] Notification(s) cancelled")
        } catch (e: Exception) {
            Log.e(TAG, "Error cancelling notification", e)
        }

        // 5a. If JS runtime is alive, let JS handle it (updates UI + calls API)
        val jsModule = NotificationHelperModule.instance
        if (jsModule != null) {
            Log.d(TAG, "[ORDER-ACTION] JS runtime alive — emitting action to OrdersScreen")
            jsModule.emitActionToJS(action, orderId)
            // JS side (OrdersScreen) will call acceptOrder/rejectOrder via its handler.
            // No need to start NativeOrderApiService.
            return
        }

        // 5b. JS runtime is dead — call the API natively without booting React Native
        Log.d(TAG, "[ORDER-ACTION] JS runtime not available — starting NativeOrderApiService")
        try {
            val serviceIntent = Intent(context, NativeOrderApiService::class.java).apply {
                putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
                putExtra(NotificationHelperModule.EXTRA_ACTION, action)
                putExtra("orderNumber", orderNumber)
            }
            context.startService(serviceIntent)
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] Failed to start NativeOrderApiService", e)
        }
    }
}

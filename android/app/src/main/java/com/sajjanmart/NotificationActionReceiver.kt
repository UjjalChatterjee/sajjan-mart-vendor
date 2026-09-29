package com.sajjanmart

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Receives ACCEPT / REJECT action intents from notification buttons.
 *
 * Responsibilities (in order):
 *   1. Receive the action in native Android (no JS runtime needed).
 *   2. Extract orderId (and orderNumber for user-facing messages).
 *   3. Stop the looping alert sound immediately — the siren must end on the
 *      fingertip, with no network wait.
 *   4. KEEP the order's notification. It is only cancelled once a decision is
 *      confirmed (JS cleanup for a live runtime, NativeOrderApiService for a
 *      killed one). Dismissing it here would silently swallow a failed call.
 *   5a. If a JS runtime is really alive → emit the event so OrdersScreen can
 *       call the API, close the modal and update the cache.
 *   5b. Otherwise → start NativeOrderApiService as a foreground service, which
 *       calls PUT /api/orders/{id} without React Native.
 *   6. Never require the user to open the app first, and never lose a tap
 *      because the runtime was assumed to be up.
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

        // 3. Silence the siren (only when this order owns it). The notification
        //    stays: ids are derived from orderId, so no other pending order's
        //    alert and no other app's notification is touched, and a failed API
        //    call leaves the admin an actionable entry to retry from.
        OrderAlertService.stopSoundKeepNotification(context, orderId)
        Log.d(TAG, "[ORDER-ALERT] Sound stopped for $orderId (notification kept)")

        // 5a. Only hand over when a JS runtime can actually receive it.
        val jsModule = NotificationHelperModule.instance
        if (jsModule != null && jsModule.canEmitToJS() && jsModule.emitActionToJS(action, orderId)) {
            Log.d(TAG, "[ORDER-ACTION] JS runtime alive — OrdersScreen owns the API call")
            return
        }

        // 5b. No JS runtime — decide natively, without booting React Native.
        Log.d(TAG, "[ORDER-ACTION] No live JS runtime — starting NativeOrderApiService")
        try {
            val serviceIntent = Intent(context, NativeOrderApiService::class.java).apply {
                putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
                putExtra(NotificationHelperModule.EXTRA_ACTION, action)
                putExtra("orderNumber", orderNumber)
            }
            // Foreground start: a plain startService() from a receiver in a
            // revived process is subject to the background-start restriction and
            // throws on Android 12+, which used to lose the tap.
            ContextCompat.startForegroundService(context, serviceIntent)
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] Failed to start NativeOrderApiService", e)
            // The order notification is still in the tray with its buttons, so
            // the alert remains recoverable; say so instead of going quiet.
            NativeOrderFeedback.show(
                context,
                "Order Action Not Sent",
                "Could not start the background submit for order #$orderNumber. " +
                    "The order alert is still here — open the app to decide it.",
            )
        }
    }
}

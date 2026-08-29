package com.sajjanmart

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receives ACCEPT / REJECT action intents from notification buttons.
 *
 * Behaviour:
 *   1. Stop the order alert sound service
 *   2. App alive  → emit event to JS, dismiss notification
 *   3. App killed → start NotificationActionService (HeadlessJsTaskService)
 */
class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "OrderAction"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val orderId = intent.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID) ?: return
        val action = intent.getStringExtra(NotificationHelperModule.EXTRA_ACTION) ?: return

        Log.d(TAG, "Action received: $action for order $orderId")

        // Always stop the alert sound first
        OrderAlertService.stop(context)

        when (action) {
            NotificationHelperModule.ACTION_ACCEPT,
            NotificationHelperModule.ACTION_REJECT -> {
                val serviceIntent = Intent(context, NotificationActionService::class.java).apply {
                    putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
                    putExtra(NotificationHelperModule.EXTRA_ACTION, action)
                }
                context.startService(serviceIntent)
            }
        }
    }
}

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
 *   2. Log the action with safe tags
 *   3. App alive  → emit event to JS, dismiss notification
 *   4. App killed → start NotificationActionService (HeadlessJsTaskService)
 *
 * Security:
 *   - Never logs FCM tokens or authentication tokens
 *   - Only logs orderId and action type
 */
class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "NotificationActionReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val orderId = intent.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID) ?: return
        val action = intent.getStringExtra(NotificationHelperModule.EXTRA_ACTION) ?: return

        val actionName = when (action) {
            NotificationHelperModule.ACTION_ACCEPT -> "ACCEPT"
            NotificationHelperModule.ACTION_REJECT -> "REJECT"
            else -> action
        }

        Log.d(TAG, "[ORDER-ACTION] $actionName for order $orderId")

        // Always stop the alert sound first
        OrderAlertService.stop(context)
        Log.d(TAG, "[ORDER-ALERT] sound stopped")

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

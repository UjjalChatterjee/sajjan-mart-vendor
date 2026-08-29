package com.sajjanmart

import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Processes notification ACCEPT / REJECT actions.
 *
 * Extends HeadlessJsTaskService so it can run JS code even when the
 * React Native UI is not currently displayed (background / killed).
 *
 * The service:
 *   1. Boots the JS runtime if not already running
 *   2. Runs the "NotificationActionTask" JS handler
 *   3. Dismisses the notification
 *   4. Stops itself
 */
class NotificationActionService : HeadlessJsTaskService() {

    companion object {
        private const val TAG = "OrderActionService"
        private const val JS_TASK_NAME = "NotificationActionTask"
        private const val TASK_TIMEOUT_MS: Long = 10_000 // 10 seconds
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val orderId = intent?.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID) ?: return null
        val action = intent.getStringExtra(NotificationHelperModule.EXTRA_ACTION) ?: return null

        Log.d(TAG, "Starting task: $action for order $orderId")

        val data = Arguments.createMap().apply {
            putString("action", action)
            putString("orderId", orderId)
        }

        return HeadlessJsTaskConfig(
            JS_TASK_NAME,
            data,
            TASK_TIMEOUT_MS,
            false, // allowForeground
        )
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed")
        super.onDestroy()
    }
}

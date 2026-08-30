package com.sajjanmart

import android.app.ActivityManager
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.invertase.firebase.common.ReactNativeFirebaseEventEmitter
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingSerializer

/**
 * Custom Firebase Messaging Service.
 *
 * Handles NEW_ORDER FCM messages natively — no dependency on React Native UI,
 * foreground JS listeners, App.tsx, or LoginScreen.
 *
 * Flow:
 *   FCM → CustomMessagingService → detect type = NEW_ORDER
 *     → App foreground: ReactNativeFirebaseMessagingReceiver emits to JS (modal shows)
 *     → App background/killed: start OrderAlertService directly
 *        → custom notification with full order details
 *        → looping alert sound
 *        → ACCEPT / REJECT actions
 *
 * This replaces the library's ReactNativeFirebaseMessagingService (which has a
 * no-op onMessageReceived). We handle:
 *   - NEW_ORDER natively (start OrderAlertService)
 *   - onNewToken by emitting to JS via ReactNativeFirebaseEventEmitter
 *     (so the TS layer can register the new FCM token)
 */
class CustomMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "CustomMessagingService"
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "[FCM] Token refreshed")
        try {
            // Delegate to React Native Firebase's event system so the
            // TS onTokenRefresh() listener fires
            val emitter = ReactNativeFirebaseEventEmitter.getSharedInstance()
            emitter.sendEvent(
                ReactNativeFirebaseMessagingSerializer.newTokenToTokenEvent(token)
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to emit token event to JS", e)
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        val type = data["type"]

        Log.d(TAG, "[FCM] Message received: type=${type ?: "unknown"}")

        if (type == "NEW_ORDER") {
            Log.d(TAG, "[FCM] NEW_ORDER received")

            val orderId = data["orderId"] ?: return
            val orderNumber = data["orderNumber"] ?: orderId
            val customerName = data["customerName"] ?: ""
            val customerPhone = data["customerPhone"] ?: ""
            val address = data["address"] ?: ""
            val total = data["total"] ?: ""
            val paymentMethod = data["paymentMethod"] ?: ""
            val paymentStatus = data["paymentStatus"] ?: ""
            val itemsJson = data["items"] ?: "[]"

            if (isAppInForeground()) {
                // App is OPEN: the ReactNativeFirebaseMessagingReceiver will
                // emit to JS which shows the NewOrderAlertModal + starts sound.
                // We do NOT start OrderAlertService here to avoid duplicate
                // notifications. The modal handles everything.
                Log.d(TAG, "[FCM] App in foreground — JS modal will handle")
            } else {
                // App BACKGROUND or KILLED: start native OrderAlertService
                // directly. No JS dependency. Immediate notification + sound.
                Log.d(TAG, "[FCM] App not in foreground — starting OrderAlertService")
                Log.d(TAG, "[ORDER-ALERT] starting")

                OrderAlertService.start(
                    context = this,
                    orderId = orderId,
                    orderNumber = orderNumber,
                    customerName = customerName,
                    customerPhone = customerPhone,
                    address = address,
                    total = total,
                    paymentMethod = paymentMethod,
                    paymentStatus = paymentStatus,
                    itemsJson = itemsJson,
                )
            }
        }
        // Other message types: the ReactNativeFirebaseMessagingReceiver handles them
    }

    /**
     * Check if the app's process is in the foreground.
     *
     * Returns true only when the Activity is visible and focused.
     * Returns false for background, service, or killed states.
     */
    private fun isAppInForeground(): Boolean {
        try {
            val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
            val procs = am.runningAppProcesses ?: return false
            for (proc in procs) {
                if (proc.processName == packageName) {
                    return proc.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking foreground state", e)
        }
        return false
    }
}

package com.sajjanmart

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Native module exposed to JS as "NotificationHelper".
 *
 * Responsibilities:
 *   - Build and display Android notifications with ACCEPT / REJECT action buttons
 *   - Dismiss a notification by its deterministic ID
 *   - Start / stop the foreground order alert service (loops alert.mp3)
 *   - Emit action events back to JS when the app is alive
 */
class NotificationHelperModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "NotificationHelper"
        const val MODULE_NAME = "NotificationHelper"
        const val CHANNEL_ID = "sajjanmart_orders"
        const val CHANNEL_NAME = "Sajjan Mart Orders"
        const val CHANNEL_DESC = "Alerts for new incoming orders"
        const val ACTION_ACCEPT = "com.sajjanmart.ORDER_ACCEPT"
        const val ACTION_REJECT = "com.sajjanmart.ORDER_REJECT"
        const val EXTRA_ORDER_ID = "order_id"
        const val EXTRA_ACTION = "order_action"
    }

    override fun getName(): String = MODULE_NAME

    /* ── Channel ── */

    private fun ensureChannel(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = reactApplicationContext.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = CHANNEL_DESC
                    enableVibration(true)
                    vibrationPattern = longArrayOf(200, 100, 200)
                    enableLights(true)
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
                nm.createNotificationChannel(channel)
            }
        }
        return CHANNEL_ID
    }

    /* ── Notification ID ── */

    /** Deterministic notification ID from order string — safe for per-order dismissal. */
    private fun notificationIdFor(orderId: String): Int {
        return (0x7FFFFFFF and orderId.hashCode())
    }

    /* ── Build & show ── */

    /**
     * Show a notification with ACCEPT / REJECT action buttons.
     *
     * JS call:
     *   NotificationHelper.showOrderNotification({
     *     orderId, customerName, itemCount, total
     *   })
     */
    @ReactMethod
    fun showOrderNotification(data: ReadableMap) {
        try {
            val ctx = reactApplicationContext
            val orderId = data.getString("orderId") ?: return
            val customerName = data.getString("customerName") ?: "New customer"
            val itemCount = data.getString("itemCount") ?: "?"
            val total = data.getString("total") ?: "0"

            val channelId = ensureChannel()
            val notifId = notificationIdFor(orderId)

            // ── PendingIntents for actions ──
            val acceptIntent = createActionIntent(ctx, ACTION_ACCEPT, orderId)
            val rejectIntent = createActionIntent(ctx, ACTION_REJECT, orderId)

            // ── Tap intent — opens the app ──
            val tapIntent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(EXTRA_ORDER_ID, orderId)
            }
            val tapPending = PendingIntent.getActivity(
                ctx, notifId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            // ── Build notification ──
            val notification = NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("Sajjan Mart")
                .setContentText("New Order #$orderId")
                .setStyle(
                    NotificationCompat.BigTextStyle()
                        .bigText("New Order #$orderId\n$customerName • $itemCount items\n₹$total")
                )
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(tapPending)
                .addAction(0, "REJECT", rejectIntent)
                .addAction(0, "ACCEPT", acceptIntent)
                .build()

            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.notify(notifId, notification)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to show notification", e)
        }
    }

    /* ── Dismiss ── */

    /**
     * Dismiss a notification by order ID.
     *
     * JS call: NotificationHelper.dismissNotification(orderId)
     */
    @ReactMethod
    fun dismissNotification(orderId: String) {
        val ctx = reactApplicationContext
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancel(notificationIdFor(orderId))
    }

    /* ── Alert Sound ── */

    /**
     * Start the foreground order alert service (loops alert.mp3).
     * Supports full order data including items, phone, address, payment.
     *
     * JS call:
     *   NotificationHelper.startOrderAlert({
     *     orderId, orderNumber, customerName, customerPhone,
     *     address, total, paymentMethod, paymentStatus, items
     *   })
     */
    @ReactMethod
    fun startOrderAlert(data: ReadableMap) {
        Log.d(TAG, "[ORDER-ALERT] startOrderAlert called from JS")

        val orderId = data.getString("orderId") ?: return
        val orderNumber = data.getString("orderNumber") ?: orderId
        val customerName = data.getString("customerName") ?: ""
        val customerPhone = data.getString("customerPhone") ?: ""
        val address = data.getString("address") ?: ""
        val total = data.getString("total") ?: ""
        val paymentMethod = data.getString("paymentMethod") ?: ""
        val paymentStatus = data.getString("paymentStatus") ?: ""
        val itemsJson = data.getString("items") ?: "[]"

        OrderAlertService.start(
            reactApplicationContext,
            orderId, orderNumber, customerName, customerPhone,
            address, total, paymentMethod, paymentStatus, itemsJson,
        )
    }

    /**
     * Stop the order alert service and release audio.
     * Safe to call multiple times.
     */
    @ReactMethod
    fun stopOrderAlert() {
        Log.d(TAG, "[ORDER-ALERT] stopOrderAlert called from JS")
        OrderAlertService.stop(reactApplicationContext)
    }

    /* ── Emit action to JS ── */

    /**
     * Called by NotificationActionReceiver when the app is alive.
     * Emits a "NotificationAction" event to JS.
     */
    fun emitActionToJS(action: String, orderId: String) {
        Log.d(TAG, "[ORDER-ACTION] Emitting to JS: $action for order $orderId")
        val params = com.facebook.react.bridge.Arguments.createMap().apply {
            putString("action", action)
            putString("orderId", orderId)
        }
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("NotificationAction", params)
    }

    /* ── Helpers ── */

    private fun createActionIntent(ctx: Context, action: String, orderId: String): PendingIntent {
        val intent = Intent(ctx, NotificationActionReceiver::class.java).apply {
            this.action = action
            putExtra(EXTRA_ORDER_ID, orderId)
            putExtra(EXTRA_ACTION, action)
        }
        // Use orderId hashCode as request code so each notification gets unique PendingIntents
        val requestCode = orderId.hashCode() or (if (action == ACTION_ACCEPT) 0x10000 else 0x20000)
        return PendingIntent.getBroadcast(
            ctx, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}

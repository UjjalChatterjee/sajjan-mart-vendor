package com.sajjanmart

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
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

    // Direct MediaPlayer for foreground-only sound (no notification)
    private var foregroundPlayer: MediaPlayer? = null
    private var foregroundPlaying = false

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

        @Volatile
        var instance: NotificationHelperModule? = null
            private set
    }

    init {
        instance = this
    }

    override fun invalidate() {
        super.invalidate()
        if (instance == this) {
            instance = null
        }
    }

    override fun getName(): String = MODULE_NAME

    /* ── Channel ── */

    /**
     * Delegate channel creation to OrderAlertService.ensureNotificationChannel()
     * — the single source of truth for the urgent order-alert channel.
     * Creating the channel from two places with different configs would be
     * unpredictable: whichever runs first wins and the second is ignored.
     */
    private fun ensureChannel(): String {
        OrderAlertService.ensureNotificationChannel(reactApplicationContext)
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
            val orderNumber = data.getString("orderNumber") ?: orderId
            val customerName = data.getString("customerName") ?: "Customer"
            val customerPhone = data.getString("customerPhone") ?: ""
            val itemCount = data.getString("itemCount") ?: "?"
            val total = data.getString("total") ?: "0"
            val paymentMethod = data.getString("paymentMethod") ?: ""
            val address = data.getString("address") ?: ""

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

            val paymentLabel = OrderAlertService.friendlyPaymentMethod(paymentMethod)

            val bigText = buildString {
                append("Order Number: #$orderNumber\n")
                if (customerName.isNotEmpty()) append("Customer: $customerName\n")
                if (customerPhone.isNotEmpty()) append("Phone: $customerPhone\n")
                if (total.isNotEmpty()) append("Total Amount: ₹$total\n")
                if (paymentMethod.isNotEmpty()) append("Payment Method: $paymentLabel\n")
                append("Items: $itemCount\n")
                if (address.isNotEmpty()) append("\nDelivery Address:\n$address")
            }.trimEnd()

            val contentText = buildString {
                append("Order #$orderNumber")
                if (customerName.isNotEmpty()) append(" • $customerName")
                if (total.isNotEmpty()) append(" • ₹$total")
                if (paymentMethod.isNotEmpty()) append(" ($paymentLabel)")
            }

            // ── Build notification ──
            val notification = NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setColor(0xFF16A34A.toInt())
                .setColorized(true)
                .setContentTitle("NEW ORDER")
                .setSubText("#$orderNumber")
                .setContentText(contentText)
                .setStyle(
                    NotificationCompat.BigTextStyle()
                        .setBigContentTitle("NEW ORDER")
                        .setSummaryText("#$orderNumber")
                        .bigText(bigText)
                )
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(false)
                .setOngoing(true)
                .setContentIntent(tapPending)
                .addAction(android.R.drawable.ic_menu_send, "ACCEPT", acceptIntent)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "REJECT", rejectIntent)
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

    /* ── Alert Sound (Foreground: sound only, no notification) ── */

    /**
     * Play alert.mp3 directly via MediaPlayer — NO foreground service,
     * NO notification. Used by the in-app modal when the app is in
     * the foreground so no system notification appears over the popup.
     *
     * JS call: NotificationHelper.startForegroundSound()
     */
    @ReactMethod
    fun startForegroundSound() {
        if (foregroundPlaying) {
            Log.d(TAG, "[ORDER-ALERT] Foreground sound already playing, skipping")
            return
        }
        foregroundPlaying = true
        try {
            val resId = reactApplicationContext.resources.getIdentifier(
                "alert", "raw", reactApplicationContext.packageName
            )
            if (resId == 0) {
                Log.e(TAG, "alert.mp3 not found in res/raw")
                foregroundPlaying = false
                return
            }
            foregroundPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(
                    reactApplicationContext,
                    android.net.Uri.parse("android.resource://${reactApplicationContext.packageName}/$resId")
                )
                isLooping = true
                setOnPreparedListener {
                    if (foregroundPlayer != null) {
                        start()
                        Log.d(TAG, "[ORDER-ALERT] Foreground sound started")
                    }
                }
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "Foreground sound error: what=$what extra=$extra")
                    foregroundPlaying = false
                    false
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground sound", e)
            foregroundPlaying = false
        }
    }

    /**
     * Stop foreground alert playback immediately.
     * Safe to call multiple times.
     */
    @ReactMethod
    fun stopForegroundSound() {
        val player = foregroundPlayer
        foregroundPlayer = null
        foregroundPlaying = false
        try {
            player?.apply {
                try { if (isPlaying) stop() } catch (_: IllegalStateException) {}
                release()
            }
            Log.d(TAG, "[ORDER-ALERT] Foreground sound stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping foreground sound", e)
        }
    }

    /* ── Alert Sound (Background/Killed: foreground service with notification) ── */

    /**
     * Start the foreground order alert service (loops alert.mp3).
     * Shows a persistent notification with ACCEPT / REJECT actions.
     * Used for background/killed states only.
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
        try {
            if (reactApplicationContext.hasActiveReactInstance()) {
                Log.d(TAG, "[ORDER-ACTION] Emitting to JS: $action for order $orderId")
                val params = com.facebook.react.bridge.Arguments.createMap().apply {
                    putString("action", action)
                    putString("orderId", orderId)
                }
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("NotificationAction", params)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not emit action to JS: ${e.message}")
        }
    }

    /* ── Helpers ── */

    private fun createActionIntent(ctx: Context, action: String, orderId: String, orderNumber: String = orderId): PendingIntent {
        val intent = Intent(ctx, NotificationActionReceiver::class.java).apply {
            this.action = action
            putExtra(EXTRA_ORDER_ID, orderId)
            putExtra(EXTRA_ACTION, action)
            putExtra("orderNumber", orderNumber)
        }
        // Use orderId hashCode as request code so each notification gets unique PendingIntents
        val requestCode = orderId.hashCode() or (if (action == ACTION_ACCEPT) 0x10000 else 0x20000)
        return PendingIntent.getBroadcast(
            ctx, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}

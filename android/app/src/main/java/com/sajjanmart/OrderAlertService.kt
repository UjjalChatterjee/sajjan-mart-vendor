package com.sajjanmart

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray

/**
 * Foreground Service that plays alert.mp3 in a continuous loop.
 *
 * The persistent notification shows full order details with
 * REJECT / ACCEPT actions so the store staff can act directly
 * from the notification even when the app is in the background or killed.
 *
 * This service is fully native — no React Native dependency.
 * It is started by:
 *   - CustomMessagingService (background/killed FCM)
 *   - NotificationHelperModule (from JS foreground)
 *   - Sound service (from TS via native module)
 */
class OrderAlertService : Service() {

    companion object {
        private const val TAG = "OrderAlertService"
        private const val CHANNEL_ID = "sajjanmart_alert"
        private const val CHANNEL_NAME = "Sajjan Mart Alert"
        private const val NOTIFICATION_ID = 9999
        private const val ACTION_STOP = "com.sajjanmart.ALERT_STOP"

        // Intent extras
        private const val EXTRA_ORDER_ID = "order_id"
        private const val EXTRA_ORDER_NUMBER = "order_number"
        private const val EXTRA_CUSTOMER_NAME = "customer_name"
        private const val EXTRA_CUSTOMER_PHONE = "customer_phone"
        private const val EXTRA_ADDRESS = "address"
        private const val EXTRA_TOTAL = "total"
        private const val EXTRA_PAYMENT_METHOD = "payment_method"
        private const val EXTRA_PAYMENT_STATUS = "payment_status"
        private const val EXTRA_ITEMS_JSON = "items_json"

        /**
         * Start the order alert service with full order details.
         * Safe to call multiple times — no duplicate players.
         */
        fun start(
            context: Context,
            orderId: String,
            orderNumber: String = orderId,
            customerName: String = "",
            customerPhone: String = "",
            address: String = "",
            total: String = "",
            paymentMethod: String = "",
            paymentStatus: String = "",
            itemsJson: String = "[]",
        ) {
            val intent = Intent(context, OrderAlertService::class.java).apply {
                putExtra(EXTRA_ORDER_ID, orderId)
                putExtra(EXTRA_ORDER_NUMBER, orderNumber)
                putExtra(EXTRA_CUSTOMER_NAME, customerName)
                putExtra(EXTRA_CUSTOMER_PHONE, customerPhone)
                putExtra(EXTRA_ADDRESS, address)
                putExtra(EXTRA_TOTAL, total)
                putExtra(EXTRA_PAYMENT_METHOD, paymentMethod)
                putExtra(EXTRA_PAYMENT_STATUS, paymentStatus)
                putExtra(EXTRA_ITEMS_JSON, itemsJson)
            }
            context.startForegroundService(intent)
        }

        /**
         * Stop the order alert service and release audio.
         * Safe to call multiple times.
         */
        fun stop(context: Context) {
            val intent = Intent(context, OrderAlertService::class.java)
            context.stopService(intent)
        }
    }

    private var mediaPlayer: MediaPlayer? = null
    private var isPlaying = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle stop action
        if (intent?.action == ACTION_STOP) {
            Log.d(TAG, "Stop action received")
            stopPlayback()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val orderId = intent?.getStringExtra(EXTRA_ORDER_ID) ?: "unknown"
        val orderNumber = intent?.getStringExtra(EXTRA_ORDER_NUMBER) ?: orderId
        val customerName = intent?.getStringExtra(EXTRA_CUSTOMER_NAME) ?: ""
        val customerPhone = intent?.getStringExtra(EXTRA_CUSTOMER_PHONE) ?: ""
        val address = intent?.getStringExtra(EXTRA_ADDRESS) ?: ""
        val total = intent?.getStringExtra(EXTRA_TOTAL) ?: ""
        val paymentMethod = intent?.getStringExtra(EXTRA_PAYMENT_METHOD) ?: ""
        val paymentStatus = intent?.getStringExtra(EXTRA_PAYMENT_STATUS) ?: ""
        val itemsJson = intent?.getStringExtra(EXTRA_ITEMS_JSON) ?: "[]"

        Log.d(TAG, "[ORDER-ALERT] starting for order: $orderId")

        try {
            // Start as foreground service with persistent notification
            val notification = buildForegroundNotification(
                orderId, orderNumber, customerName, customerPhone,
                address, total, paymentMethod, paymentStatus, itemsJson,
            )
            startForeground(NOTIFICATION_ID, notification)
            Log.d(TAG, "[ORDER-ALERT] notification created")

            // Start looping playback
            startPlayback()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground service or playback", e)
            stopSelf()
            return START_NOT_STICKY
        }

        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed")
        stopPlayback()
        super.onDestroy()
    }

    // ── Playback ──

    private fun startPlayback() {
        if (isPlaying) {
            Log.d(TAG, "Playback already active — skipping")
            return
        }

        try {
            val resId = resources.getIdentifier("alert", "raw", packageName)
            if (resId == 0) {
                Log.e(TAG, "alert.mp3 not found in res/raw")
                return
            }

            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(applicationContext, android.net.Uri.parse("android.resource://$packageName/$resId"))
                isLooping = true
                setOnPreparedListener {
                    start()
                    this@OrderAlertService.isPlaying = true
                    Log.d(TAG, "[ORDER-ALERT] sound started")
                }
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "Alert playback error: what=$what extra=$extra")
                    this@OrderAlertService.isPlaying = false
                    false
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start alert playback", e)
            isPlaying = false
        }
    }

    private fun stopPlayback() {
        try {
            mediaPlayer?.apply {
                if (isPlaying) stop()
                release()
            }
            mediaPlayer = null
            isPlaying = false
            Log.d(TAG, "Alert playback stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping alert playback", e)
            mediaPlayer = null
            isPlaying = false
        }
    }

    // ── Notification Channel ──

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "Continuous alert for new orders"
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 500, 0, 500)
                    setBypassDnd(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    // ── Build Notification ──

    private fun buildForegroundNotification(
        orderId: String,
        orderNumber: String,
        customerName: String,
        customerPhone: String,
        address: String,
        total: String,
        paymentMethod: String,
        paymentStatus: String,
        itemsJson: String,
    ): Notification {
        val channelId = CHANNEL_ID

        // ── Action intents ──
        val rejectIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationHelperModule.ACTION_REJECT
            putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
            putExtra(NotificationHelperModule.EXTRA_ACTION, NotificationHelperModule.ACTION_REJECT)
        }
        val rejectPending = PendingIntent.getBroadcast(
            this,
            orderId.hashCode() or 0x20000,
            rejectIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val acceptIntent = Intent(this, NotificationActionReceiver::class.java).apply {
            action = NotificationHelperModule.ACTION_ACCEPT
            putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
            putExtra(NotificationHelperModule.EXTRA_ACTION, NotificationHelperModule.ACTION_ACCEPT)
        }
        val acceptPending = PendingIntent.getBroadcast(
            this,
            orderId.hashCode() or 0x10000,
            acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // ── Tap intent — open app ──
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_ORDER_ID, orderId)
        }
        val tapPending = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // ── Build compact items text ──
        val itemsText = buildItemsText(itemsJson)

        // ── Build full notification text ──
        val bigText = buildString {
            append("Order #${orderNumber}")

            // Customer info
            if (customerName.isNotEmpty()) {
                append("\n\nCustomer: $customerName")
            }
            if (customerPhone.isNotEmpty()) {
                append("\nPhone: $customerPhone")
            }
            if (address.isNotEmpty()) {
                append("\nAddress: $address")
            }

            // Items list
            if (itemsText.isNotEmpty()) {
                append("\n\nItems:")
                append(itemsText)
            }

            // Total
            if (total.isNotEmpty()) {
                append("\n\nTotal: ₹$total")
            }

            // Payment
            if (paymentMethod.isNotEmpty() || paymentStatus.isNotEmpty()) {
                append("\nPayment: ")
                if (paymentMethod.isNotEmpty()) append(paymentMethod)
                if (paymentMethod.isNotEmpty() && paymentStatus.isNotEmpty()) append(" / ")
                if (paymentStatus.isNotEmpty()) append(paymentStatus)
            }
        }

        // ── Build content text (truncated for collapsed view) ──
        val contentText = buildString {
            append("Order #${orderNumber}")
            if (customerName.isNotEmpty()) append(" • $customerName")
            if (total.isNotEmpty()) append(" • ₹$total")
        }

        return NotificationCompat.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("🛒 NEW ORDER")
            .setContentText(contentText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(tapPending)
            .addAction(0, "REJECT", rejectPending)
            .addAction(0, "ACCEPT", acceptPending)
            .build()
    }

    /**
     * Parse the items JSON array and build a compact text representation.
     *
     * Expected JSON format:
     * [
     *   { "name": "Product A", "quantity": 2, "price": 100 },
     *   { "name": "Product B", "quantity": 1, "price": 150 }
     * ]
     */
    private fun buildItemsText(itemsJson: String): String {
        try {
            val items = JSONArray(itemsJson)
            if (items.length() == 0) return ""

            return buildString {
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    val name = item.optString("name", "Item")
                    val qty = item.optInt("quantity", 1)
                    val price = item.optDouble("price", 0.0)

                    append("\n  • $name × $qty")
                    if (price > 0) {
                        append(" — ₹${String.format("%.0f", price * qty)}")
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse items JSON", e)
            return ""
        }
    }
}

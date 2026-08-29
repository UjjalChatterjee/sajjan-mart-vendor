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

/**
 * Foreground Service that plays alert.mp3 in a continuous loop.
 *
 * The persistent notification shows REJECT / ACCEPT actions so the
 * store staff can act directly from the notification even when the
 * app is in the background or killed.
 */
class OrderAlertService : Service() {

    companion object {
        private const val TAG = "OrderAlertService"
        private const val CHANNEL_ID = "sajjanmart_alert"
        private const val CHANNEL_NAME = "Sajjan Mart Alert"
        private const val NOTIFICATION_ID = 9999
        private const val ACTION_STOP = "com.sajjanmart.ALERT_STOP"
        private const val EXTRA_ORDER_ID = "order_id"
        private const val EXTRA_CUSTOMER_NAME = "customer_name"
        private const val EXTRA_ITEM_COUNT = "item_count"
        private const val EXTRA_TOTAL = "total"

        fun start(context: Context, orderId: String, customerName: String = "", itemCount: String = "", total: String = "") {
            val intent = Intent(context, OrderAlertService::class.java).apply {
                putExtra(EXTRA_ORDER_ID, orderId)
                putExtra(EXTRA_CUSTOMER_NAME, customerName)
                putExtra(EXTRA_ITEM_COUNT, itemCount)
                putExtra(EXTRA_TOTAL, total)
            }
            context.startForegroundService(intent)
        }

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
        val customerName = intent?.getStringExtra(EXTRA_CUSTOMER_NAME) ?: ""
        val itemCount = intent?.getStringExtra(EXTRA_ITEM_COUNT) ?: ""
        val total = intent?.getStringExtra(EXTRA_TOTAL) ?: ""
        Log.d(TAG, "Starting alert for order: $orderId")
        Log.d(TAG, "Alert audio resource: alert.mp3 (native OrderAlertService)")

        try {
            // Start as foreground service with persistent notification
            startForeground(NOTIFICATION_ID, buildForegroundNotification(orderId, customerName, itemCount, total))

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
                Log.e(TAG, "Alert audio resource: MISSING (res/raw/alert.mp3)")
                return
            }

            Log.d(TAG, "Alert audio resource: alert.mp3 (res/raw/alert.mp3, id=$resId)")

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
                    Log.d(TAG, "Alert playback started (looping)")
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
        if (!isPlaying && mediaPlayer == null) {
            Log.d(TAG, "Alert playback stop requested — nothing active")
            return
        }

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

    // ── Notification ──

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
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    private fun buildForegroundNotification(
        orderId: String,
        customerName: String,
        itemCount: String,
        total: String,
    ): Notification {
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
        // Use SINGLE_TOP (not CLEAR_TOP) to avoid destroying and recreating
        // the Activity, which would kill the React Native bridge.
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_ORDER_ID, orderId)
        }
        val tapPending = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // ── Build content text ──
        val bigText = buildString {
            append("Order #$orderId")
            if (customerName.isNotEmpty() || itemCount.isNotEmpty()) {
                append("\n")
                if (customerName.isNotEmpty()) append(customerName)
                if (customerName.isNotEmpty() && itemCount.isNotEmpty()) append(" • ")
                if (itemCount.isNotEmpty()) append("$itemCount items")
            }
            if (total.isNotEmpty()) {
                append("\n₹$total")
            }
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("Sajjan Mart — New Order")
            .setContentText("Order #$orderId")
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
}

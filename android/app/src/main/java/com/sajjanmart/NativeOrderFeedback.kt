package com.sajjanmart

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * The one place native-only code posts a status notification about an order
 * action: the foreground-service "submitting" entry and the outcome entries.
 *
 * They live on their own quiet channel (IMPORTANCE_LOW, no sound, no
 * vibration): an order alert already owns the urgent channel's siren and buzz,
 * and a status line must not re-ring either — that would break the "exactly one
 * vibration per alert" rule as soon as a decision is submitted.
 */
object NativeOrderFeedback {

    private const val TAG = "NativeOrderFeedback"

    const val CHANNEL_ID = "sajjanmart_order_actions"
    const val CHANNEL_NAME = "Order action status"

    /** Ongoing foreground-service notification while a decision is in flight. */
    const val ID_PROGRESS = 0x454E5631

    /** Outcome of a submit (success, already handled, or failed). */
    const val ID_RESULT = 0x4F524445

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                description = "Silent status for background order accept / reject submissions"
                setSound(null, null)
                enableVibration(false)
            },
        )
    }

    /**
     * Post (or replace) a status notification.
     *
     * [orderId] is only ever used to build the tap intent that opens the app on
     * that order — which is what makes a failed submit recoverable instead of
     * silently dropped.
     */
    fun show(
        context: Context,
        id: Int,
        title: String,
        text: String,
        orderId: String? = null,
        ongoing: Boolean = false,
    ) {
        ensureChannel(context)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setSilent(true)

        if (!ongoing) {
            val tapIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                if (orderId != null) {
                    putExtra(NotificationHelperModule.EXTRA_ORDER_ID, orderId)
                }
            }
            builder.setContentIntent(
                PendingIntent.getActivity(
                    context,
                    id,
                    tapIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
        }

        try {
            context.getSystemService(NotificationManager::class.java).notify(id, builder.build())
            Log.d(TAG, "[ORDER-ACTION] Status notification posted: $title")
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] Could not post status notification: ${e.message}")
        }
    }

    fun cancel(context: Context, id: Int) {
        try {
            context.getSystemService(NotificationManager::class.java).cancel(id)
        } catch (e: Exception) {
            Log.w(TAG, "[ORDER-ACTION] Could not clear status notification: ${e.message}")
        }
    }

    /** Convenience for callers that only have a message (receiver error paths). */
    fun show(context: Context, title: String, text: String) {
        show(context, ID_RESULT, title, text, orderId = null)
    }
}

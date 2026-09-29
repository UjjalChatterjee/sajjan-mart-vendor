package com.sajjanmart

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder

/**
 * Native service that calls the Accept/Reject order API directly —
 * no React Native JS runtime dependency.
 *
 * Used when the app is backgrounded or killed: the JS runtime is not
 * running and we cannot rely on HeadlessJsTask cold boot being fast
 * or reliable enough for a time-sensitive order action.
 *
 * Flow:
 *   NotificationActionReceiver
 *     → stop OrderAlertService   (looping sound + notification detach)
 *     → cancel notification      (remove from system tray immediately)
 *     → start NativeOrderApiService
 *         → read access token from AsyncStorage SQLite DB
 *         → PUT /api/orders/{orderId}  { "status": "confirmed" | "cancelled" }
 *         → on success: log
 *         → on failure: show informative feedback notification
 *
 * Token storage:
 *   @react-native-async-storage uses a Room-backed SQLite DB:
 *     Database : "AsyncStorage"
 *     Table    : "Storage"
 *     Key col  : "key"      Value col : "value"
 *     Access token key : "@sajjanmart:accessToken"
 *
 * Base URL candidates (tried in order):
 *   1. http://127.0.0.1:3000  — physical device / local Metro server
 *   2. http://10.0.2.2:3000   — Android emulator loopback alias for host
 */
class NativeOrderApiService : Service() {

    companion object {
        private const val TAG = "NativeOrderApiService"
        private const val ACTION_ACCEPT = "com.sajjanmart.ORDER_ACCEPT"
        private const val ACTION_REJECT = "com.sajjanmart.ORDER_REJECT"

        // AsyncStorage Room DB constants (from @react-native-async-storage source)
        private const val DB_NAME           = "AsyncStorage"
        private const val TABLE_NAME        = "Storage"
        private const val COLUMN_KEY        = "key"
        private const val COLUMN_VALUE      = "value"
        private const val ACCESS_TOKEN_KEY  = "@sajjanmart:accessToken"
        private const val REFRESH_TOKEN_KEY = "@sajjanmart:refreshToken"

        // API base URL candidates — tried in order
        private val BASE_URL_CANDIDATES = listOf(
            "http://127.0.0.1:3000",  // physical device / dev machine
            "http://10.0.2.2:3000",   // Android emulator → host machine
        )

        private const val CONNECT_TIMEOUT_MS  = 12_000
        private const val READ_TIMEOUT_MS     = 12_000
        // Informational notification shown when the API call fails
        private const val FEEDBACK_NOTIF_ID   = 0x4F524445
    }

    private enum class ApiResult { SUCCESS, AUTH_ERROR, SERVER_ERROR, NETWORK_ERROR, CONFLICT }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val orderId     = intent?.getStringExtra(NotificationHelperModule.EXTRA_ORDER_ID)
        val action      = intent?.getStringExtra(NotificationHelperModule.EXTRA_ACTION)
        val orderNumber = intent?.getStringExtra("orderNumber") ?: orderId

        if (orderId == null || action == null) {
            Log.e(TAG, "[ORDER-ACTION] Missing orderId or action — stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        val actionName = when (action) {
            ACTION_ACCEPT -> "ACCEPT"
            ACTION_REJECT -> "REJECT"
            else          -> action
        }

        val newStatus = when (action) {
            ACTION_ACCEPT -> "confirmed"
            ACTION_REJECT -> "cancelled"
            else -> {
                Log.e(TAG, "[ORDER-ACTION] Unknown action: $action")
                stopSelf()
                return START_NOT_STICKY
            }
        }

        Log.d(TAG, "[ORDER-ACTION] $actionName for order $orderId (status → $newStatus)")

        // All network work on a background thread — never block the main thread
        Thread {
            try {
                val token = readTokenFromDb(ACCESS_TOKEN_KEY)
                if (token == null) {
                    Log.w(TAG, "[ORDER-ACTION] No access token — attempting token refresh")
                    val refreshed = tryRefreshToken()
                    if (refreshed == null) {
                        Log.e(TAG, "[ORDER-ACTION] Token refresh failed — cannot call API")
                        showFeedbackNotification(
                            "Order Action Failed",
                            "Not signed in. Open the app to $actionName order #$orderNumber manually.",
                        )
                    } else {
                        executeApi(orderId, orderNumber ?: orderId, newStatus, actionName, refreshed)
                    }
                } else {
                    executeApi(orderId, orderNumber ?: orderId, newStatus, actionName, token)
                }
            } catch (e: Exception) {
                Log.e(TAG, "[ORDER-ACTION] Unexpected error: ${e.message}", e)
                showFeedbackNotification(
                    "Order Action Failed",
                    "Unexpected error for order #$orderNumber. Open the app to retry.",
                )
            }
            stopSelf()
        }.start()

        return START_NOT_STICKY
    }

    // ── API execution ─────────────────────────────────────────────────────────

    private fun executeApi(
        orderId: String,
        orderNumber: String,
        newStatus: String,
        actionName: String,
        token: String,
    ) {
        Log.d(TAG, "[ORDER-ACTION] Calling PUT /api/orders/$orderId status=$newStatus")
        val encodedId = URLEncoder.encode(orderId, "UTF-8")
        val bodyBytes = JSONObject().apply { put("status", newStatus) }.toString().toByteArray()

        val result = callOrderApiWithFallback(encodedId, bodyBytes, token)

        when (result) {
            ApiResult.SUCCESS -> {
                Log.d(TAG, "[ORDER-ACTION] ✓ $actionName order $orderId confirmed by server")
                // Notification already cancelled by NotificationActionReceiver
                // Remember the confirmed decision so a duplicate or late
                // NEW_ORDER push for this order can never ring again.
                OrderDecisionStore.markResolved(applicationContext, orderId)
            }
            ApiResult.CONFLICT -> {
                // 409 — another device already moved this order out of pending.
                // The backend kept the first decision; ours is stale.
                Log.w(TAG, "[ORDER-ACTION] 409 — order $orderId already decided on another device")
                OrderDecisionStore.markResolved(applicationContext, orderId)
                showFeedbackNotification(
                    "Order Already Handled",
                    "Order #$orderNumber was already accepted or rejected on another device.",
                )
            }
            ApiResult.AUTH_ERROR -> {
                // 401/403 — token may have just expired; try refresh and retry once
                Log.w(TAG, "[ORDER-ACTION] Auth error (401/403) — refreshing token and retrying")
                val newToken = tryRefreshToken()
                if (newToken != null) {
                    val retry = callOrderApiWithFallback(encodedId, bodyBytes, newToken)
                    if (retry == ApiResult.SUCCESS) {
                        Log.d(TAG, "[ORDER-ACTION] ✓ $actionName order $orderId — retry succeeded")
                        OrderDecisionStore.markResolved(applicationContext, orderId)
                        return
                    }
                    if (retry == ApiResult.CONFLICT) {
                        Log.w(TAG, "[ORDER-ACTION] 409 on retry — order $orderId already decided")
                        OrderDecisionStore.markResolved(applicationContext, orderId)
                        showFeedbackNotification(
                            "Order Already Handled",
                            "Order #$orderNumber was already accepted or rejected on another device.",
                        )
                        return
                    }
                }
                showFeedbackNotification(
                    "Order Action Failed — Auth Error",
                    "Session expired. Open the app to $actionName order #$orderNumber.",
                )
            }
            ApiResult.NETWORK_ERROR -> {
                showFeedbackNotification(
                    "Order Action Failed — No Connection",
                    "Could not reach server. Open the app to $actionName order #$orderNumber.",
                )
            }
            else -> {
                showFeedbackNotification(
                    "Order Action Failed",
                    "Server error. Open the app to $actionName order #$orderNumber manually.",
                )
            }
        }
    }

    // ── SQLite token helpers ──────────────────────────────────────────────────

    /**
     * Read any value from the AsyncStorage SQLite database.
     * Tries two path conventions in order:
     *   1. context.getDatabasePath("AsyncStorage")  — standard Room location
     *   2. <dataDir>/databases/AsyncStorage           — explicit fallback
     */
    private fun readTokenFromDb(key: String): String? {
        val candidates = listOf(
            getDatabasePath(DB_NAME),
            java.io.File(filesDir.parentFile, "databases/$DB_NAME"),
        )
        for (dbFile in candidates) {
            if (!dbFile.exists()) continue
            try {
                val db = android.database.sqlite.SQLiteDatabase.openDatabase(
                    dbFile.absolutePath, null,
                    android.database.sqlite.SQLiteDatabase.OPEN_READONLY,
                )
                var value: String? = null
                val cursor = db.rawQuery(
                    "SELECT `$COLUMN_VALUE` FROM `$TABLE_NAME` WHERE `$COLUMN_KEY` = ?",
                    arrayOf(key),
                )
                if (cursor.moveToFirst()) value = cursor.getString(0)
                cursor.close()
                db.close()
                if (!value.isNullOrEmpty()) {
                    Log.d(TAG, "[ORDER-ACTION] Read '$key' from ${dbFile.name}")
                    return value
                }
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ACTION] DB read error at ${dbFile.name}: ${e.message}")
            }
        }
        Log.e(TAG, "[ORDER-ACTION] Key '$key' not found in AsyncStorage DB")
        return null
    }

    private fun persistTokenToDb(key: String, value: String) {
        val candidates = listOf(
            getDatabasePath(DB_NAME),
            java.io.File(filesDir.parentFile, "databases/$DB_NAME"),
        )
        for (dbFile in candidates) {
            if (!dbFile.exists()) continue
            try {
                val db = android.database.sqlite.SQLiteDatabase.openDatabase(
                    dbFile.absolutePath, null,
                    android.database.sqlite.SQLiteDatabase.OPEN_READWRITE,
                )
                val cv = android.content.ContentValues().apply {
                    put(COLUMN_KEY, key)
                    put(COLUMN_VALUE, value)
                }
                db.insertWithOnConflict(
                    TABLE_NAME, null, cv,
                    android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE,
                )
                db.close()
                return
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ACTION] DB write error at ${dbFile.name}: ${e.message}")
            }
        }
    }

    // ── Token refresh ─────────────────────────────────────────────────────────

    /**
     * Attempt a token refresh via POST /api/auth/refresh.
     * Sends the stored refresh token as a Cookie header, matching the JS api.client.ts logic.
     * Persists the new access token to AsyncStorage on success.
     */
    private fun tryRefreshToken(): String? {
        val refreshToken = readTokenFromDb(REFRESH_TOKEN_KEY) ?: return null
        for (baseUrl in BASE_URL_CANDIDATES) {
            try {
                val url  = URL("$baseUrl/api/auth/refresh")
                val conn = url.openConnection() as HttpURLConnection
                try {
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("Cookie", "refreshToken=$refreshToken")
                    conn.connectTimeout = CONNECT_TIMEOUT_MS
                    conn.readTimeout    = READ_TIMEOUT_MS
                    conn.doOutput = true
                    conn.outputStream.use { it.write("{}".toByteArray()) }

                    val code = conn.responseCode
                    if (code in 200..299) {
                        val body = conn.inputStream.bufferedReader().readText()
                        val json = JSONObject(body)
                        val newToken = json.optString("accessToken").takeIf { it.isNotEmpty() }
                            ?: json.optString("token").takeIf { it.isNotEmpty() }
                        if (newToken != null) {
                            Log.d(TAG, "[ORDER-ACTION] Token refresh succeeded via $baseUrl")
                            persistTokenToDb(ACCESS_TOKEN_KEY, newToken)
                            return newToken
                        }
                    } else {
                        Log.w(TAG, "[ORDER-ACTION] Refresh HTTP $code from $baseUrl")
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (e: ConnectException) {
                Log.w(TAG, "[ORDER-ACTION] Refresh: connect failed to $baseUrl")
            } catch (e: Exception) {
                Log.w(TAG, "[ORDER-ACTION] Refresh error ($baseUrl): ${e.message}")
            }
        }
        return null
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    /**
     * Call PUT /api/orders/{encodedId} trying each base URL candidate.
     * Returns SUCCESS on 2xx, AUTH_ERROR on 401/403, SERVER_ERROR on other 4xx/5xx,
     * NETWORK_ERROR when no URL could be reached at all.
     */
    private fun callOrderApiWithFallback(
        encodedId: String,
        bodyBytes: ByteArray,
        token: String,
    ): ApiResult {
        for (baseUrl in BASE_URL_CANDIDATES) {
            val result = callOrderApi(baseUrl, encodedId, bodyBytes, token)
            if (result != ApiResult.NETWORK_ERROR) return result
            Log.w(TAG, "[ORDER-ACTION] $baseUrl unreachable, trying next candidate")
        }
        return ApiResult.NETWORK_ERROR
    }

    private fun callOrderApi(
        baseUrl: String,
        encodedId: String,
        bodyBytes: ByteArray,
        token: String,
    ): ApiResult {
        return try {
            val url  = URL("$baseUrl/api/orders/$encodedId")
            val conn = url.openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "PUT"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept",       "application/json")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout    = READ_TIMEOUT_MS
                conn.doOutput       = true
                conn.outputStream.use { os: OutputStream -> os.write(bodyBytes) }

                val code = conn.responseCode
                Log.d(TAG, "[ORDER-ACTION] PUT $baseUrl/api/orders/$encodedId → HTTP $code")

                // Log body for debugging (truncated, no tokens)
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                if (stream != null) {
                    val resp = BufferedReader(InputStreamReader(stream)).readText()
                    Log.d(TAG, "[ORDER-ACTION] Response: ${resp.take(300)}")
                }

                when (code) {
                    in 200..299 -> ApiResult.SUCCESS
                    401, 403    -> ApiResult.AUTH_ERROR
                    // The atomic pending-exit transition answered: another device
                    // already decided this order.
                    409         -> ApiResult.CONFLICT
                    else        -> ApiResult.SERVER_ERROR
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: ConnectException) {
            Log.w(TAG, "[ORDER-ACTION] ConnectException ($baseUrl): ${e.message}")
            ApiResult.NETWORK_ERROR
        } catch (e: SocketTimeoutException) {
            Log.w(TAG, "[ORDER-ACTION] Timeout ($baseUrl): ${e.message}")
            ApiResult.NETWORK_ERROR
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] HTTP error ($baseUrl): ${e.message}")
            ApiResult.NETWORK_ERROR
        }
    }

    // ── Feedback notification ─────────────────────────────────────────────────

    /**
     * Show a small, auto-cancelling informational notification so the admin
     * knows the background API call failed and needs manual attention.
     * Uses the existing orders notification channel — no new channel needed.
     */
    private fun showFeedbackNotification(title: String, text: String) {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notification = NotificationCompat.Builder(this, NotificationHelperModule.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setOngoing(false)
                .build()
            nm.notify(FEEDBACK_NOTIF_ID, notification)
            Log.d(TAG, "[ORDER-ACTION] Feedback notification shown: $title")
        } catch (e: Exception) {
            Log.e(TAG, "[ORDER-ACTION] Could not show feedback notification: ${e.message}")
        }
    }
}

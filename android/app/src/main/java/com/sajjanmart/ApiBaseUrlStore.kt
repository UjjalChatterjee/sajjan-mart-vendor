package com.sajjanmart

import android.content.Context
import android.util.Log

/**
 * The API base URL the JS runtime is actually talking to, persisted so the
 * native-only paths (killed-app ACCEPT / REJECT) can reach the same server.
 *
 * Same single-store rule as the notification-sound switch: JavaScript writes it
 * through NotificationHelper.setApiBaseUrl (src/config/apiBaseUrl.ts mirrors
 * Env.API_BASE_URL) and Kotlin reads it straight from this file. There is
 * deliberately NO URL constant here — a second copy is how the killed-app
 * action path ended up calling http://127.0.0.1:3000 while the app was talking
 * to the deployed backend.
 *
 * Absent until the first JS run writes it, which is also when the auth tokens
 * exist, so a missing value means "this device cannot decide an order natively
 * yet" rather than "guess an address".
 */
object ApiBaseUrlStore {
    private const val TAG = "ApiBaseUrlStore"
    private const val PREFS_NAME = "sajjanmart_notifications"
    private const val KEY_API_BASE_URL = "api_base_url"

    /** Trimmed, no trailing slash, http/https only. Null when unusable. */
    @JvmStatic
    fun normalize(raw: String?): String? {
        val trimmed = raw?.trim()?.trimEnd('/') ?: return null
        if (trimmed.isEmpty()) return null
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else null
    }

    @JvmStatic
    fun save(context: Context, rawUrl: String?): Boolean {
        val url = normalize(rawUrl)
        if (url == null) {
            Log.e(TAG, "[ORDER-ACTION] setApiBaseUrl rejected — not an http(s) URL")
            return false
        }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_API_BASE_URL, url)
            .apply()
        Log.d(TAG, "[ORDER-ACTION] API base URL persisted for native paths: $url")
        return true
    }

    @JvmStatic
    fun read(context: Context): String? =
        normalize(
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_API_BASE_URL, null),
        )
}

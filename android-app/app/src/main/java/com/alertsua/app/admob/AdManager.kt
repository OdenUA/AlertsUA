package com.alertsua.app.admob

import android.content.Context
import android.content.SharedPreferences

object AdManager {
    private const val PREFS_NAME = "ad_prefs"
    private const val KEY_ADS_DISABLED = "ads_disabled"

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    fun areAdsDisabled(context: Context): Boolean {
        return getPrefs(context).getBoolean(KEY_ADS_DISABLED, false)
    }

    fun setAdsDisabled(context: Context, disabled: Boolean) {
        getPrefs(context).edit().putBoolean(KEY_ADS_DISABLED, disabled).apply()
    }

    fun toggleAds(context: Context): Boolean {
        val currentState = areAdsDisabled(context)
        val newState = !currentState
        setAdsDisabled(context, newState)
        return newState
    }
}

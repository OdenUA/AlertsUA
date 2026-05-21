package com.alertsua.app.rateprompt

import android.content.Context
import android.util.Log
import java.time.LocalDate

class RatePromptManager(context: Context) {

    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        private const val PREFS_NAME = "RatePromptPrefs"
        private const val KEY_FIRST_LAUNCH_DATE = "first_launch_date"
        private const val KEY_LAST_OPEN_DATE = "last_open_date"
        private const val KEY_CONSECUTIVE_DAYS = "consecutive_days"
        private const val KEY_SNOOZE_UNTIL = "snooze_until"
        private const val KEY_NEVER_SHOW = "never_show"
        private const val KEY_HAS_RATED = "has_rated"

        const val DAYS_TO_SHOW = 5
        const val SNOOZE_DAYS = 3
        const val EXTRA_FORCE_SHOW = "com.alertsua.app.FORCE_RATE_PROMPT"
    }

    fun recordAppOpen() {
        val today = LocalDate.now().toEpochDay()
        val lastOpen = preferences.getLong(KEY_LAST_OPEN_DATE, 0)
        val neverShow = preferences.getBoolean(KEY_NEVER_SHOW, false)

        if (neverShow) return

        val editor = preferences.edit()

        when {
            lastOpen == 0L -> {
                editor.putLong(KEY_FIRST_LAUNCH_DATE, today)
                editor.putLong(KEY_LAST_OPEN_DATE, today)
                editor.putInt(KEY_CONSECUTIVE_DAYS, 1)
            }
            lastOpen == today - 1 -> {
                val currentStreak = preferences.getInt(KEY_CONSECUTIVE_DAYS, 1)
                editor.putInt(KEY_CONSECUTIVE_DAYS, currentStreak + 1)
                editor.putLong(KEY_LAST_OPEN_DATE, today)
            }
            lastOpen == today -> {
                return
            }
            else -> {
                editor.putInt(KEY_CONSECUTIVE_DAYS, 1)
                editor.putLong(KEY_LAST_OPEN_DATE, today)
            }
        }
        editor.apply()
    }

    fun shouldShowPrompt(): Boolean {
        val neverShow = preferences.getBoolean(KEY_NEVER_SHOW, false)
        if (neverShow) {
            Log.d("RatePromptManager", "shouldShowPrompt=false (never_show=true)")
            return false
        }

        val hasRated = preferences.getBoolean(KEY_HAS_RATED, false)
        if (hasRated) {
            Log.d("RatePromptManager", "shouldShowPrompt=false (has_rated=true)")
            return false
        }

        val snoozeUntil = preferences.getLong(KEY_SNOOZE_UNTIL, 0)
        val today = LocalDate.now().toEpochDay()
        if (snoozeUntil > today) {
            Log.d("RatePromptManager", "shouldShowPrompt=false (snoozed until $snoozeUntil, today=$today)")
            return false
        }

        val consecutiveDays = preferences.getInt(KEY_CONSECUTIVE_DAYS, 0)
        val result = consecutiveDays >= DAYS_TO_SHOW
        Log.d("RatePromptManager", "shouldShowPrompt=$result (consecutiveDays=$consecutiveDays, DAYS_TO_SHOW=$DAYS_TO_SHOW)")
        return result
    }

    fun onLaterClicked() {
        val snoozeUntil = LocalDate.now().plusDays(SNOOZE_DAYS.toLong()).toEpochDay()
        preferences.edit()
            .putLong(KEY_SNOOZE_UNTIL, snoozeUntil)
            .apply()
    }

    fun onNeverClicked() {
        preferences.edit()
            .putBoolean(KEY_NEVER_SHOW, true)
            .apply()
    }

    fun onRated() {
        preferences.edit()
            .putBoolean(KEY_HAS_RATED, true)
            .apply()
    }

    fun getConsecutiveDays(): Int = preferences.getInt(KEY_CONSECUTIVE_DAYS, 0)

    fun isNeverShow(): Boolean = preferences.getBoolean(KEY_NEVER_SHOW, false)

    fun hasRated(): Boolean = preferences.getBoolean(KEY_HAS_RATED, false)

    fun getSnoozeUntil(): Long = preferences.getLong(KEY_SNOOZE_UNTIL, 0)

    // Для тестирования: устанавливает streak напрямую
    fun setConsecutiveDaysForTesting(days: Int) {
        preferences.edit()
            .putInt(KEY_CONSECUTIVE_DAYS, days)
            .putLong(KEY_LAST_OPEN_DATE, LocalDate.now().toEpochDay())
            .apply()
        Log.d("RatePromptManager", "Set consecutiveDays=$days for testing")
    }

    // Для тестирования: сбрасывает все настройки
    fun resetForTesting() {
        preferences.edit().clear().apply()
        Log.d("RatePromptManager", "Reset all prefs for testing")
    }
}

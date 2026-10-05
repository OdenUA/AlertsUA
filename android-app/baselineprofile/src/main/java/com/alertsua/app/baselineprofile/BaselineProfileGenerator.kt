package com.alertsua.app.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test

/**
 * Генерирует baseline-prof.txt для release-сборки: записывает классы/методы,
 * которые реально выполняются при старте, чтобы ART компилировал их AOT
 * при установке приложения (Play Console: медленные тёплые/горячие старты).
 *
 * Запуск: gradle :app:generateReleaseBaselineProfile (нужен подключённый
 * эмулятор/устройство API 29+; на эмуляторе — cold boot, без снапшота).
 */
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generateStartupProfile() = rule.collect(
        packageName = "com.alertsua.app",
        // Профиль запуска (раскладка DEX при установке) + обычный baseline-профиль
        includeInStartupProfile = true,
        // Полный сценарий: pressHome + startActivityAndWait + ожидание карты
        profileBlock = {
            pressHome()
            startActivityAndWait()

            // Карта догружает GeoJSON-геометрию и ставит слои несколько секунд —
            // это часть критического пути холодного старта, профилируем и её.
            device.wait(
                Until.hasObject(By.pkg("com.alertsua.app")),
                30_000,
            )
            Thread.sleep(15_000)
            device.waitForIdle()
        },
    )
}

@echo off
rem --- Емулятор Android: AVD Pixel_6 живе не в дефолтному %USERPROFILE%\.android\avd,
rem     тому ANDROID_AVD_HOME задаємо явно ---
set "ANDROID_AVD_HOME=D:\Dev\Android\.android\avd"
set "EMULATOR=D:\Dev\Android\SDK\emulator\emulator.exe"

if not exist "%EMULATOR%" (
    echo [!] Emulator not found: %EMULATOR%
    echo     Перевірте шлях до Android SDK.
    pause
    exit /b 1
)

echo [*] Запуск емулятора Pixel_6 (AVD: %ANDROID_AVD_HOME%)...
start "" "%EMULATOR%" -avd Pixel_6 %*

plugins {
    id("com.android.test")
    id("androidx.baselineprofile")
}

android {
    namespace = "com.alertsua.app.baselineprofile"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    targetProjectPath = ":app"
}

dependencies {
    // BaselineProfileRule живёт в benchmark-macro-junit4 (не в androidx.baselineprofile)
    implementation("androidx.benchmark:benchmark-macro-junit4:1.5.0")
}

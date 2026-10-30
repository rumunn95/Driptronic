package pl.olejarka

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.MediaScannerConnection
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.atan2

class MainActivity : ComponentActivity(), SensorEventListener {
    private lateinit var ble: BleManager
    private lateinit var web: WebView
    private var pageReady = false
    private var autoConnectActive = true
    private var currentView = "hud"

    /** Tryb pionowy HUD (telefon w uchwycie pionowo) — z Ustawień → Wyświetlacz. */
    private var hudVertical = false
    private val uiHandler = Handler(Looper.getMainLooper())

    private lateinit var sensorManager: SensorManager
    private val grav = FloatArray(3)
    private var gravValid = false
    private var baselineGx = Float.NaN
    private var baselineGy = Float.NaN
    private var baselineGz = Float.NaN
    private var lastTiltSentMs = 0L
    private var lastGPeakSentMs = 0L
    private var lastLuxSentMs = 0L

    // -------------------------------------------------- GPS (natywnie, jak Maps/Yanosik)
    // Źródło pozycji: LocationManager (GPS_PROVIDER, fix co ~5 s), sterowane z JS:
    // gpsListen(true) = jazda/trip (nasłuchuj), gpsListen(false) = postój (wyłącz).
    private var locationManager: LocationManager? = null
    private var gpsNativeOn = false
    private var lastGpsArmMs = 0L
    private var lastGpsFixSentMs = 0L
    private val gpsListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            val nowMs = SystemClock.elapsedRealtime()
            if (nowMs - lastGpsFixSentMs >= 900) {
                lastGpsFixSentMs = nowMs
                sendGpsFix(loc)
            }
        }
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    private var pendingChartPng: ByteArray? = null
    private var pendingChartName = ""

    private var pendingProfileJson: String? = null
    private var pendingProfileName = ""

    // Alarm wypadku: ton alarmowy (ToneGenerator trzymany między wywołaniami, żeby dało się zatrzymać).
    private var crashTone: android.media.ToneGenerator? = null
    // Czy apka rozpoczęła połączenie alarmowe (żeby móc je zakończyć przy anulowaniu).
    private var crashCallActive = false

    // -------------------------------------------------- śledzenie jazdy (FGS)
    private var rideActive = false
    private var rideMovingSec = 0
    private var rideIdleSec = 0
    private val rideHandler = Handler(Looper.getMainLooper())
    private val rideGoneRunnable = Runnable { stopRide("utracono BLE") }

    private fun startRideTracker() {
        lifecycleScope.launch {
            ble.state.collect { trackRide(it) }
        }
    }

    private fun trackRide(value: StatePacket?) {
        if (value == null) {
            rideHandler.removeCallbacks(rideGoneRunnable)
            rideHandler.postDelayed(rideGoneRunnable, 25000L)
            return
        }
        rideHandler.removeCallbacks(rideGoneRunnable)
        if (value.speedKph >= 5f) {
            if (rideMovingSec < 600) rideMovingSec++
            rideIdleSec = 0
        } else {
            rideIdleSec++
            if (rideMovingSec > 0) rideMovingSec--
        }
        if (!rideActive && rideMovingSec >= 8) {
            rideActive = true
            rideMovingSec = 0
            RideService.start(applicationContext)
        } else if (rideActive && rideIdleSec >= 30) {
            stopRide("koniec jazdy")
        }
    }

    private fun stopRide(reason: String) {
        if (!rideActive) return
        rideActive = false
        rideMovingSec = 0
        rideIdleSec = 0
        rideHandler.removeCallbacks(rideGoneRunnable)
        RideService.stop(applicationContext)
    }

    private val writePerm =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                if (pendingProfileJson != null) saveProfileLegacy() else saveChartLegacy()
            } else toast("Brak uprawnienia do zapisu")
        }

    private val profilePicker =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) readProfile(uri)
        }

    private fun toast(text: String) =
        runOnUiThread { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }

    private val permissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (::web.isInitialized) {
                web.postDelayed({ if (!ble.connected) ble.startScan() }, 350L)
            }
        }

    // Osobny launcher dla uprawnień alarmu: po decyzji odświeżamy widok ustawień,
    // żeby „Uprawnienia: przyznane" pojawiło się od razu (wcześniej status się nie zmieniał).
    private val alertPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (::web.isInitialized) {
                val sms = result[Manifest.permission.SEND_SMS]
                    ?: (ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED)
                val call = result[Manifest.permission.CALL_PHONE]
                    ?: (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED)
                toast("Uprawnienia alarmu — SMS: " + (if (sms) "tak" else "NIE") + ", telefon: " + (if (call) "tak" else "NIE"))
                web.evaluateJavascript("window.crashRefreshPerms&&window.crashRefreshPerms();", null)
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyImmersive()

        ble = BleManager(applicationContext)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        Notifier.ensureChannels(this)
        startRideTracker()
        val prefs = getSharedPreferences("olejarka", Context.MODE_PRIVATE)
        baselineGx = prefs.getFloat("tilt_x", Float.NaN)
        baselineGy = prefs.getFloat("tilt_y", Float.NaN)
        baselineGz = prefs.getFloat("tilt_z", Float.NaN)
        web = WebView(this).apply {
            setBackgroundColor(Color.rgb(14, 17, 23))
            webViewClient = WebViewClient()
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setGeolocationEnabled(true)
            settings.allowFileAccess = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            webChromeClient = object : WebChromeClient() {
                override fun onGeolocationPermissionsShowPrompt(
                    origin: String?,
                    callback: android.webkit.GeolocationPermissions.Callback
                ) {
                    callback.invoke(origin, true, false)
                }
            }
            addJavascriptInterface(NativeBridge(), "AndroidBle")
        }
        setContentView(web)
        // Podgląd nawigacji w kolumnie OBD: powiadomienia nawigacyjne → WebView.
        NavNotifyListener.sink = { pkg, title, text ->
            val payload = JSONObject()
                .put("pkg", pkg)
                .put("title", title)
                .put("text", text)
                .toString()
            evaluate("window.__onNavNotify&&window.__onNavNotify(" + JSONObject.quote(payload) + ");")
        }
        // Klawiatura i edge-to-edge (targetSdk 36): samo okno nie kurczy się pod
        // klawiaturą (adjustResize jest ignorowane przy setDecorFitsSystemWindows=false).
        // Skracamy WebView do obszaru NAD klawiaturą — klawiatura zostaje na dole
        // na całą szerokość ekranu, a strona kończy się tuż nad nią, więc okienka
        // z polami tekstowymi i przyciskami są zawsze widoczne. Po zamknięciu
        // klawiatury WebView wraca do pełnej wysokości.
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            // Wysokość całego ekranu (WebView w trybie pełnoekranowym zajmuje go cały).
            val fullHeight = window.decorView.rootView.height
            val imeBottom = if (imeVisible) ime.bottom else 0
            val target = if (imeBottom > 0) {
                // Klawiatura otwarta (także pływająca): strona kończy się nad nią.
                (fullHeight - imeBottom).coerceAtLeast(1)
            } else {
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            }
            val lp = web.layoutParams
            if (lp.height != target) {
                lp.height = target
                web.layoutParams = lp
            }
            insets
        }
        web.requestApplyInsets()
        web.loadUrl("file:///android_asset/native/index.html")
        requestBlePermissions()
        observeBle()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBackPressedCustom()
        })
    }

    private fun onBackPressedCustom() {
        if (::web.isInitialized && currentView != "hud") {
            evaluate("window.nativeShowHud&&window.nativeShowHud();")
            return
        }
        if (::web.isInitialized) evaluate("window.nativeExitAsk&&window.nativeExitAsk();")
    }

    /**
     * Orientacja ekranu: pion tylko dla widoku jazdy (HUD) i tylko gdy włączono
     * tryb pionowy w Ustawieniach. Pozostałe widoki (ustawienia, wykresy, tripy,
     * pulpit) zostają poziomo — wykresy i mapy wyglądają tam jak dotąd.
     *
     * Blokada jest deterministyczna (PORTRAIT / SENSOR_LANDSCAPE), a nie „sensor”,
     * więc wstrząsy na motocyklu nie przerzucą HUD-u między osiami.
     */
    private fun applyOrientation() {
        val portrait = currentView == "hud" && hudVertical
        runOnUiThread {
            requestedOrientation = if (portrait) {
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            } else {
                ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    override fun onStart() {
        super.onStart()
        sensorManager.registerListener(
            this,
            sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY)
                ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER),
            SensorManager.SENSOR_DELAY_UI
        )
        sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT)?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    override fun onStop() {
        sensorManager.unregisterListener(this)
        locationManager?.removeUpdates(gpsListener)
        gpsNativeOn = false
        // Powiedz JS, że nasłuch zdjęty — inaczej flaga w JS zostaje „włączona"
        // i GPS nie wraca po powrocie do apki.
        evaluate("window.nativeGpsStopped&&window.nativeGpsStopped();")
        val attrs = window.attributes
        attrs.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = attrs
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        if (pageReady && ble.connected) evaluate("window.nativeSendDate&&window.nativeSendDate();")
        // Powrót z ustawień systemowych — odśwież stan dostępu do powiadomień
        // (karta nawigacji może zostać przeklikana w tryb „włącz dostęp").
        if (pageReady) evaluate("window.__navPermRefresh&&window.__navPermRefresh();")
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type == Sensor.TYPE_LIGHT) {
            val lux = event.values[0].coerceAtLeast(0f)
            val nowMs = SystemClock.elapsedRealtime()
            if (pageReady && nowMs - lastLuxSentMs >= 1000) {
                lastLuxSentMs = nowMs
                evaluate("window.nativeSetLux($lux);")
            }
            return
        }
        synchronized(grav) {
            if (!gravValid) {
                System.arraycopy(event.values, 0, grav, 0, 3)
                gravValid = true
                return
            }
            val a = 0.72f
            for (i in 0..2) grav[i] = a * grav[i] + (1 - a) * event.values[i]
        }
        val deg = currentTiltDeg()
        val nowMs = SystemClock.elapsedRealtime()
        // Moduł przyspieszenia (bez grawitacji wygładzonej) do wykrywania piku przeciążenia.
        val gMag = kotlin.math.sqrt(
            event.values[0] * event.values[0] +
                event.values[1] * event.values[1] +
                event.values[2] * event.values[2]
        )
        if (pageReady && nowMs - lastTiltSentMs >= 120) {
            lastTiltSentMs = nowMs
            evaluate("window.nativeSetTilt($deg);")
        }
        if (pageReady && gMag > 2.4f && nowMs - lastGPeakSentMs >= 500) {
            lastGPeakSentMs = nowMs
            evaluate("window.nativeSetGPeak($gMag);")
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun currentTiltDeg(): Float {
        synchronized(grav) {
            if (!gravValid || baselineGx.isNaN()) return Float.NaN
            var g0n = kotlin.math.sqrt(baselineGx * baselineGx + baselineGy * baselineGy + baselineGz * baselineGz)
            if (g0n < 1e-3f) return Float.NaN
            var gn = kotlin.math.sqrt(grav[0] * grav[0] + grav[1] * grav[1] + grav[2] * grav[2])
            if (gn < 1e-3f) return Float.NaN
            val b0x = baselineGx / g0n
            val b0y = baselineGy / g0n
            val b0z = baselineGz / g0n
            val gx = grav[0] / gn
            val gy = grav[1] / gn
            val gz = grav[2] / gn

            // Oś przechyłu (wzdłuż jazdy) = pozioma składowa normalnej ekranu (Z) względem osi pionu.
            var fX = -b0x * b0z
            var fY = -b0y * b0z
            var fZ = 1.0f - b0z * b0z
            var fn = fX * fX + fY * fY + fZ * fZ
            if (fn < 1e-4f) {
                val xy1 = -b0x * b0y
                val yy1 = 1.0f - b0y * b0y
                val zy1 = -b0z * b0y
                val a = xy1 * xy1 + yy1 * yy1 + zy1 * zy1
                val xx1 = 1.0f - b0x * b0x
                val yx1 = -b0y * b0x
                val zx1 = -b0z * b0x
                val b = xx1 * xx1 + yx1 * yx1 + zx1 * zx1
                if (a >= b) { fX = xy1; fY = yy1; fZ = zy1; fn = a }
                else { fX = xx1; fY = yx1; fZ = zx1; fn = b }
            }
            if (fn < 1e-4f) return Float.NaN
            val fl = kotlin.math.sqrt(fn)
            fX /= fl; fY /= fl; fZ /= fl

            // Rzut obecnej grawitacji na płaszczyznę prostopadłą do osi przechyłu.
            val gf = gx * fX + gy * fY + gz * fZ
            val px = gx - gf * fX
            val py = gy - gf * fY
            val pz = gz - gf * fZ

            // Kąt obrotu b0 -> p wokół osi f (pełna 3D, brak kompresji rzutu X-Y).
            val det = fX * (b0y * pz - b0z * py) +
                      fY * (b0z * px - b0x * pz) +
                      fZ * (b0x * py - b0y * px)
            val dot = px * b0x + py * b0y + pz * b0z
            return Math.toDegrees(atan2(det.toDouble(), dot.toDouble())).toFloat()
        }
    }

    override fun onDestroy() {
        stopRide("zamknięcie aplikacji")
        ble.disconnect()
        web.destroy()
        autoConnectActive = false
        super.onDestroy()
    }

    private fun applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.rgb(14, 17, 23)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.rgb(14, 17, 23)
    }

    private fun requestBlePermissions() {
        val needed = if (Build.VERSION.SDK_INT >= 31) {
            if (Build.VERSION.SDK_INT >= 33) {
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.POST_NOTIFICATIONS
                )
            } else {
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                )
            }
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permissions.launch(missing.toTypedArray())
    }

    private fun observeBle() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { ble.state.collect { sendState(it) } }
                launch { ble.config.collect { sendConfig(it) } }
                launch { ble.status.collect { sendStatus(it) } }
                launch { ble.rssi.collect { sendRssi(it) } }
                launch { ble.dtc.collect { sendDtc(it) } }
            }
        }
    }

    private fun evaluate(script: String) {
        if (!pageReady) return
        web.post { web.evaluateJavascript(script, null) }
    }

    private fun sendState(value: StatePacket?) {
        if (value == null) return
        val json = JSONObject()
            .put("speed", value.speedKph)
            .put("imp", value.impulses)
            .put("pct", value.progressPct)
            .put("dd", value.dosesToday)
            .put("dt", value.dosesTotal)
            .put("zd", value.usageTodayMl)
            .put("zt", value.usageTotalMl)
            .put("poz", value.oilMl)
            .put("temp", value.tempC ?: JSONObject.NULL)
            .put("obdCoolant", value.obdCoolantC ?: JSONObject.NULL)
            .put("rpm", value.obdRpm)
            .put("obdFuel", value.fuelRateLh)
            .put("fuelTotal", value.fuelTotalL)
            .put("distance", value.distanceKm)
            .put("load", value.loadPct)
            .put("throttle", value.throttlePct)
            .put("tilt", currentTiltDeg().let { if (it.isNaN()) JSONObject.NULL else it })
            .put("trip", value.tripKm)
            .put("fuelLevel", value.fuelLevelL)
            .put("rain", value.rainOn)
            .put("spdObd", value.speedFromObd)
            .put("auto", value.autoOn)
            .put("dose", value.doseMode ?: JSONObject.NULL)
            .put("pumping", value.bleedOn)
            .put("emergencyMode", value.emergencyMode)
            .put("emergencyPending", value.emergencyPending)
        evaluate("window.nativeSetState(${json});")
    }

    private fun sendConfig(value: ConfigPacket?) {
        if (value == null) return
        val json = JSONObject()
            .put("intervalImp", value.intervalImp)
            .put("valveOpenMs", value.valveOpenMs)
            .put("pumpRunMs", value.pumpRunMs)
            .put("pumpImp", value.pumpImp)
            .put("dailyLimitImp", value.dailyLimitImp)
            .put("wheelCircumCm", value.wheelCircumCm)
            .put("minSpeedKph", value.minSpeedKph)
            .put("pumpFlowMlPer1k", value.pumpFlowMlPer1k)
            .put("tankCapacityMl", value.tankCapacityMl)
            .put("emergencyMin", value.emergencyMin)
            .put("actuatorType", value.actuatorType)
            .put("tempCal", value.tempCalC)
            .put("fuelCal", value.fuelCalX100)
            .put("distCal", value.distCalX100)
        evaluate("window.nativeSetConfig(${json});")
    }

    private fun sendStatus(value: String) {
        val connected = ble.connected
        val safe = JSONObject.quote(value)
        evaluate("window.nativeSetStatus($safe, $connected);")
    }

    private fun sendRssi(value: Int?) {
        evaluate("window.nativeSetBtRssi(${value ?: 0});")
    }

    private fun sendDtc(value: String?) {
        if (value == null) return
        evaluate("window.nativeSetDtc(${JSONObject.quote(value)});")
    }

    private fun setGpsListen(on: Boolean) {
        val lm = locationManager ?: return
        if (on == gpsNativeOn) return
        try {
            if (on) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
                gpsNativeOn = true
                lastGpsArmMs = SystemClock.elapsedRealtime()
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 0f, gpsListener, Looper.getMainLooper())
            } else {
                gpsNativeOn = false
                lm.removeUpdates(gpsListener)
                sendGpsFixOff()
            }
        } catch (e: Exception) {
            gpsNativeOn = false
        }
    }

    // Świeży fix tuż przed jazdą (start tripu): ostatnia znana pozycja + włącz nasłuch.
    private fun requestGpsFix() {
        val lm = locationManager ?: return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        try {
            lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)?.let { sendGpsFix(it) }
        } catch (e: Exception) { /* brak pozycji — JS pokaże „czekam na GPS" */ }
        // Wymuś świeży nasłuch: flaga mogła zostać zdjęta poza JS (onStop) albo provider
        // przestał dostarczać fixy — wtedy samo gpsNativeOn = true nic nie daje.
        // Reset najwyżej co 30 s, żeby nie przerywać zdobywania fixa.
        val nowEl = SystemClock.elapsedRealtime()
        if (!gpsNativeOn || nowEl - lastGpsArmMs > 30000L) {
            lastGpsArmMs = nowEl
            try {
                lm.removeUpdates(gpsListener)
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 0f, gpsListener, Looper.getMainLooper())
                gpsNativeOn = true
            } catch (e: Exception) {
                gpsNativeOn = false
            }
        }
    }

    private fun sendGpsFix(loc: Location) {
        if (!pageReady) return
        val json = JSONObject()
            .put("lat", Math.round(loc.latitude * 1e6) / 1e6)
            .put("lon", Math.round(loc.longitude * 1e6) / 1e6)
            .put("acc", Math.round(loc.accuracy))
            .put("speed", if (loc.hasSpeed()) Math.round(loc.speed * 10) / 10.0 else JSONObject.NULL)
            .put("t", if (loc.time > 0L) loc.time else System.currentTimeMillis())
        evaluate("window.nativeSetGpsFix(${json});")
    }

    private fun sendGpsFixOff() {
        if (!pageReady) return
        evaluate("window.nativeSetGpsFix(null);")
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun pageReady() {
            pageReady = true
            sendStatus(ble.status.value)
            sendState(ble.state.value)
            sendConfig(ble.config.value)
            scheduleAutoConnect(700L)
        }

        @JavascriptInterface
        fun connect() = ble.startScan()

        @JavascriptInterface
        fun gpsListen(on: Boolean) = setGpsListen(on)

        @JavascriptInterface
        fun gpsFixNow() = requestGpsFix()

        @JavascriptInterface
        fun disconnect() = ble.disconnect()

        @JavascriptInterface
        fun isConnected(): Boolean = ble.connected

        @JavascriptInterface
        fun finishApp() {
            ble.disconnect()
            uiHandler.postDelayed({ finish() }, 1300L)
        }

        @JavascriptInterface
        fun setView(view: String) {
            currentView = if (view == "hud" || view == "settings" || view == "charts" || view == "profiles" || view == "errors" || view == "trips" || view == "pulpit") view else "hud"
            // Pion tylko na ekranie jazdy; pozostałe widoki zawsze poziomo.
            applyOrientation()
        }

        /** Tryb pionowy HUD z Ustawień → Wyświetlacz (zapamiętany w apce po stronie JS). */
        @JavascriptInterface
        fun setHudVertical(vertical: Boolean) {
            hudVertical = vertical
            applyOrientation()
        }

        @JavascriptInterface
        fun sendCommand(command: String) = ble.sendCommand(command)

        @JavascriptInterface
        fun setBrightness(brightness: Double) {
            val v = brightness.toFloat().coerceIn(-1f, 1f)
            runOnUiThread {
                val attrs = window.attributes
                attrs.screenBrightness = v
                window.attributes = attrs
            }
        }

        @JavascriptInterface
        fun sendSet(key: String, value: String) {
            val num = value.toDoubleOrNull() ?: return
            val text = if (num == Math.rint(num)) num.toLong().toString() else num.toString()
            ble.sendCommand("SET $key $text")
        }

        @JavascriptInterface
        fun sendDate() = ble.sendDate()

        @JavascriptInterface
        fun calibrateTilt() {
            val ok: Boolean
            synchronized(grav) {
                ok = gravValid
                if (ok) {
                    baselineGx = grav[0]
                    baselineGy = grav[1]
                    baselineGz = grav[2]
                    getSharedPreferences("olejarka", Context.MODE_PRIVATE).edit()
                        .putFloat("tilt_x", grav[0])
                        .putFloat("tilt_y", grav[1])
                        .putFloat("tilt_z", grav[2])
                        .apply()
                }
            }
            toast(if (ok) "Poziom zapisany — przechył liczony względnie" else "Brak odczytu czujnika")
        }

        @JavascriptInterface
        fun clearTilt() {
            baselineGx = Float.NaN
            baselineGy = Float.NaN
            baselineGz = Float.NaN
            getSharedPreferences("olejarka", Context.MODE_PRIVATE).edit()
                .remove("tilt_x").remove("tilt_y").remove("tilt_z").apply()
            toast("Kalibracja przechyłu usunięta")
        }

        @JavascriptInterface
        fun saveChart(dataUrl: String) {
            if (!dataUrl.startsWith("data:image/png;base64,")) {
                toast("Nieobsługiwany format")
                return
            }
            val bytes = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
            if (bytes.size < 200) {
                toast("Brak danych wykresu")
                return
            }
            pendingChartPng = bytes
            pendingChartName =
                "olejarka-wykres-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) + ".png"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveChartModern()
            } else if (ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                saveChartLegacy()
            } else {
                writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        @JavascriptInterface
        fun saveProfile(json: String) {
            if (json.isBlank()) {
                toast("Brak danych do zapisania")
                return
            }
            pendingProfileJson = json
            pendingProfileName =
                "olejarka-kopia-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) + ".json"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveProfileModern()
            } else if (ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                saveProfileLegacy()
            } else {
                writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        @JavascriptInterface
        fun saveTripFile(name: String, content: String) {
            if (content.isBlank()) {
                toast("Brak danych do zapisania")
                return
            }
            pendingProfileJson = content
            pendingProfileName = if (name.isBlank()) {
                "olejarka-plik-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            } else name
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveProfileModern()
            } else if (ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                saveProfileLegacy()
            } else {
                writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        @JavascriptInterface
        fun notifyAlert(title: String, text: String) =
            Notifier.alert(this@MainActivity, title, text, true)

        /**
         * Alarm wypadku: wysyła SMS na podane numery i (opcjonalnie) próbuje połączenia
         * głosowego na pierwszy numer, żeby zwrócić uwagę odbiorcy.
         */
        @JavascriptInterface
        fun sendCrashAlert(numbersJson: String, message: String, callFirst: Boolean): Boolean {
            var ok = false
            try {
                val arr = org.json.JSONArray(numbersJson)
                val smsOk = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.SEND_SMS
                ) == PackageManager.PERMISSION_GRANTED
                if (!smsOk) {
                    runOnUiThread { toast("Brak uprawnienia SMS — dotknij „Przyznaj uprawnienia”") }
                    return false
                }
                val sm: android.telephony.SmsManager? =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        getSystemService(android.telephony.SmsManager::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        android.telephony.SmsManager.getDefault()
                    }
                if (sm == null) {
                    runOnUiThread { toast("Brak usługi SMS w tym telefonie") }
                    return false
                }
                var sent = 0
                var failed = 0
                for (i in 0 until arr.length()) {
                    val num = arr.optString(i, "").trim()
                    if (num.isEmpty()) continue
                    try {
                        val parts = sm.divideMessage(message)
                        sm.sendMultipartTextMessage(num, null, parts, null, null)
                        sent++
                        ok = true
                    } catch (t: Throwable) {
                        failed++
                    }
                }
                if (message.isNotEmpty()) {
                    val info = "SMS: wysłano do $sent" + (if (failed > 0) ", błąd $failed" else "") + " / " + arr.length()
                    runOnUiThread { toast(info) }
                }
                if (callFirst && arr.length() > 0) {
                    val first = arr.optString(0, "").trim()
                    val callOk = ContextCompat.checkSelfPermission(
                        this@MainActivity, Manifest.permission.CALL_PHONE
                    ) == PackageManager.PERMISSION_GRANTED
                    if (first.isNotEmpty() && callOk) {
                        try {
                            startActivity(
                                Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(first)))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                            crashCallActive = true
                        } catch (t: Throwable) {
                            runOnUiThread { toast("Nie udało się zadzwonić: " + t.message) }
                        }
                    } else if (first.isNotEmpty() && !callOk) {
                        runOnUiThread { toast("Brak uprawnienia CALL_PHONE — nie dzwonię") }
                    }
                }
            } catch (t: Throwable) {
                runOnUiThread { toast("Błąd alarmu: " + t.message) }
            }
            return ok
        }

        /** Kończy połączenie alarmowe rozpoczęte przez aplikację (przycisk „JEST OK"). */
        @JavascriptInterface
        fun crashEndCall() {
            if (!crashCallActive) return
            crashCallActive = false
            // endCall nie jest publicznym API. Próbujemy refleksją (działa na części ROM-ów),
            // a gdy się nie uda — wysyłamy akcję zakończenia połączenia przez telecom.
            try {
                val tm = getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
                val method = Class.forName(tm.javaClass.name).getDeclaredMethod("endCall")
                method.isAccessible = true
                method.invoke(tm)
                return
            } catch (t: Throwable) {
            }
            try {
                // Android 10+: zakończenie przez TelecomManager (wymaga uprawnienia ANSWER_PHONE_CALLS
                // lub bycia domyślną aplikacją telefonu — gdy brak, po prostu nie zadziała).
                val intent = Intent("android.intent.action.END_CALL").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
            } catch (t: Throwable) {
            }
        }

        @JavascriptInterface
        fun requestAlertPermissions() {
            val needed = arrayOf(Manifest.permission.SEND_SMS, Manifest.permission.CALL_PHONE)
                .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
            if (needed.isNotEmpty()) {
                alertPermissions.launch(needed.toTypedArray())
            } else {
                toast("Uprawnienia SMS i telefonu są już przyznane")
            }
        }

        @JavascriptInterface
        fun hasAlertPermissions(): Boolean =
            ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED

        /** Ustawienia systemowe: dostęp do powiadomień (wymagany dla podglądu nawigacji). */
        @JavascriptInterface
        fun openNotificationSettings() {
            runOnUiThread {
                try {
                    startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))
                } catch (t: Throwable) {
                    toast("Brak ustawień powiadomień w tym systemie")
                }
            }
        }

        /** Czy przyznano dostęp do powiadomień (nasza usługa nasłuchu jest włączona). */
        @JavascriptInterface
        fun navNotifyGranted(): Boolean {
            return try {
                // publiczne API (SystemApi getEnabledNotificationListeners() jest
                // niewidoczne dla zwykłego SDK) — zalecana droga przez core-ktx
                NotificationManagerCompat.getEnabledListenerPackages(this@MainActivity)
                    .contains(packageName)
            } catch (t: Throwable) {
                false
            }
        }

        /**
         * Dotknięcie karty nawigacji: systemowe okienko „Otwórz za pomocą…" z zainstalowanymi
         * nawigacjami. Główny intent (geo:) łapie apki z własnym filtrem geo (Mapy Google,
         * Mapy.com), a nawigacje bez takiego filtra (np. Yanosik) dorzucamy jako dodatkowe
         * pozycje choosera — bez konieczności wracania do menu. Cel: dom (strefa home).
         */
        @JavascriptInterface
        fun openNavChooser() {
            runOnUiThread {
                try {
                    val uri = Uri.parse("geo:51.992544,23.136177")
                    val pm = packageManager
                    val chooser = Intent.createChooser(
                        Intent(Intent.ACTION_VIEW, uri), "Otwórz za pomocą nawigacji"
                    )
                    val extras = ArrayList<android.os.Parcelable>()
                    for (pkg in NavNotifyListener.NAV_PACKAGES) {
                        // Apka obsługuje geo: — pokaże się w głównym wyborze, nie dublujemy.
                        if (Intent(Intent.ACTION_VIEW, uri).setPackage(pkg)
                                .resolveActivity(pm) != null
                        ) continue
                        // Bez geo: — dorzucamy start wybranej nawigacji (np. Yanosik).
                        pm.getLaunchIntentForPackage(pkg)?.let { extras.add(it) }
                    }
                    if (extras.isNotEmpty()) {
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
                    }
                    startActivity(chooser)
                } catch (t: Throwable) {
                    toast("Brak zainstalowanej nawigacji")
                }
            }
        }

        @JavascriptInterface
        fun crashAlarm(on: Boolean) {
            val v: android.os.Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
            }
            try {
                if (on) {
                    val pattern = longArrayOf(0, 500, 200, 500, 200, 500, 200, 500)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v.vibrate(android.os.VibrationEffect.createWaveform(pattern, 0))
                    } else {
                        @Suppress("DEPRECATION")
                        v.vibrate(pattern, 0)
                    }
                } else {
                    v.cancel()
                }
            } catch (t: Throwable) {
            }
        }

        @JavascriptInterface
        fun crashSound(on: Boolean) {
            try {
                if (on) {
                    if (crashTone == null) {
                        // STREAM_ALARM = głośny kanał alarmowy (omija wyciszenie multimediów).
                        crashTone = android.media.ToneGenerator(android.media.AudioManager.STREAM_ALARM, 100)
                    }
                    crashTone?.startTone(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 3000)
                } else {
                    crashTone?.stopTone()
                    crashTone?.release()
                    crashTone = null
                }
            } catch (t: Throwable) {
            }
        }

        @JavascriptInterface
        fun pickProfile() = profilePicker.launch(arrayOf("application/json", "text/*", "*/*"))

        @JavascriptInterface
        fun readDtc() = ble.requestDtc()

        @JavascriptInterface
        fun clearDtc() = ble.clearDtc()

        @JavascriptInterface
        fun requestState() = ble.requestState()

        @JavascriptInterface
        fun saveTripImage(dataUrl: String) {
            if (!dataUrl.startsWith("data:image/png;base64,")) {
                toast("Nieobsługiwany format")
                return
            }
            val bytes = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
            if (bytes.size < 200) {
                toast("Brak danych mapy")
                return
            }
            pendingChartPng = bytes
            pendingChartName =
                "olejarka-trip-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) + ".png"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveChartModern()
            } else if (ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                saveChartLegacy()
            } else {
                writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        @JavascriptInterface
        fun saveScreen(name: String) {
            val safe = if (name.isBlank()) "olejarka-ekran.png" else name
            val bmp = Bitmap.createBitmap(web.width, web.height, Bitmap.Config.ARGB_8888)
            web.draw(Canvas(bmp))
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            bmp.recycle()
            pendingChartPng = out.toByteArray()
            pendingChartName = safe
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveChartModern()
            } else if (ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                saveChartLegacy()
            } else {
                writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }

        @JavascriptInterface
        fun saveFullPage(name: String) {
            val safe = if (name.isBlank()) "olejarka-ekran-caly.png" else name
            web.post { captureFullPage(safe) }
        }
    }

    private fun captureFullPage(name: String) {
        val width = web.width.coerceAtLeast(1)
        val viewportHeight = web.height.coerceAtLeast(1)
        val contentHeight = web.contentHeight.coerceAtLeast(viewportHeight).coerceAtMost(8000)
        val oldScrollX = web.scrollX
        val oldScrollY = web.scrollY
        val output = Bitmap.createBitmap(width, contentHeight, Bitmap.Config.ARGB_8888)
        val outputCanvas = Canvas(output)

        fun finish() {
            web.scrollTo(oldScrollX, oldScrollY)
            val bytes = ByteArrayOutputStream()
            output.compress(Bitmap.CompressFormat.PNG, 100, bytes)
            output.recycle()
            pendingChartPng = bytes.toByteArray()
            pendingChartName = name
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveChartModern()
            } else if (ContextCompat.checkSelfPermission(
                    this, Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == PackageManager.PERMISSION_GRANTED
            ) {
                saveChartLegacy()
            } else {
                writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
            evaluate("window.nativeFinishFullCapture&&window.nativeFinishFullCapture();")
        }

        fun drawNext(y: Int) {
            web.scrollTo(0, y)
            web.postDelayed({
                val slice = Bitmap.createBitmap(width, viewportHeight, Bitmap.Config.ARGB_8888)
                web.draw(Canvas(slice))
                outputCanvas.drawBitmap(slice, 0f, y.toFloat(), null)
                slice.recycle()
                val nextY = (y + viewportHeight).coerceAtMost(contentHeight - viewportHeight)
                if (nextY > y) drawNext(nextY) else finish()
            }, 150L)
        }

        if (contentHeight <= viewportHeight) {
            web.scrollTo(0, 0)
            web.postDelayed({
                web.draw(outputCanvas)
                finish()
            }, 150L)
        } else {
            drawNext(0)
        }
    }

    private fun saveChartModern() {
        val bytes = pendingChartPng ?: return
        val name = pendingChartName
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Olejarka")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri: Uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: run {
                toast("Nie można utworzyć pliku")
                return
            }
        runCatching {
            val out = contentResolver.openOutputStream(uri) ?: error("no stream")
            out.use { it.write(bytes) }
        }.onFailure {
            contentResolver.delete(uri, null, null)
            toast("Błąd zapisu")
        }.onSuccess {
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            toast("Zapisano w Galerii: Pictures/Olejarka")
        }
    }

    private fun saveChartLegacy() {
        val bytes = pendingChartPng ?: return
        val name = pendingChartName
        runCatching {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Olejarka")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, name)
            file.writeBytes(bytes)
            MediaScannerConnection.scanFile(this, arrayOf(file.absolutePath), arrayOf("image/png"), null)
        }.onFailure {
            toast("Błąd zapisu")
        }.onSuccess {
            toast("Zapisano w Galerii: Pictures/Olejarka")
        }
    }

    private fun saveProfileModern() {
        val json = pendingProfileJson ?: return
        val name = pendingProfileName
        val mime = if (name.endsWith(".gpx", true) || name.endsWith(".xml", true)) {
            "application/gpx+xml"
        } else {
            "application/json"
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Olejarka")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri: Uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: run {
                toast("Nie można utworzyć pliku")
                return
            }
        runCatching {
            val out = contentResolver.openOutputStream(uri) ?: error("no stream")
            out.write(json.toByteArray(Charsets.UTF_8))
        }.onFailure {
            contentResolver.delete(uri, null, null)
            toast("Błąd zapisu")
        }.onSuccess {
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            toast("Zapisano: Download/Olejarka")
        }
    }

    private fun saveProfileLegacy() {
        val json = pendingProfileJson ?: return
        val name = pendingProfileName
        val mime = if (name.endsWith(".gpx", true) || name.endsWith(".xml", true)) {
            "application/gpx+xml"
        } else {
            "application/json"
        }
        runCatching {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Olejarka")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, name)
            file.writeText(json)
            MediaScannerConnection.scanFile(this, arrayOf(file.absolutePath), arrayOf(mime), null)
        }.onFailure {
            toast("Błąd zapisu")
        }.onSuccess {
            toast("Zapisano: Download/Olejarka")
        }
    }

    private fun readProfile(uri: Uri) {
        val text = runCatching {
            contentResolver.openInputStream(uri)?.use { it.readBytes() }?.toString(Charsets.UTF_8)
        }.getOrNull()
        if (text.isNullOrBlank()) {
            toast("Nie można odczytać pliku")
            return
        }
        val quoted = JSONObject.quote(text)
        evaluate("window.nativeApplyProfile(${quoted});")
        toast("Przywracanie profilu…")
    }

    private fun scheduleAutoConnect(delayMs: Long) {
        web.postDelayed({
            if (autoConnectActive) {
                if (!ble.connected) ble.startScan()
                scheduleAutoConnect(8000L)
            }
        }, delayMs)
    }
}

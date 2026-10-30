package pl.olejarka

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.os.ParcelUuid
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Calendar
import java.util.LinkedList

/**
 * Centralna klasa BLE: skan, GATT, subskrypcje state/config, auto-reconnect.
 *
 * Android wykonuje operacje GATT pojedynczo (1 na raz) - kazda kolejna jest
 * odrzucana, dopoki poprzednia nie zakonczy. Dlatego wszystkie operacje ida
 * przez kolejke (enqueue/opComplete) i startuja dopiero po callbacku.
 */
@SuppressLint("MissingPermission")
@Suppress("DEPRECATION")
class BleManager(private val context: Context) {

    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private val handler = Handler(Looper.getMainLooper())

    private var gatt: BluetoothGatt? = null
    private var device: BluetoothDevice? = null
    private var scanner: android.bluetooth.le.BluetoothLeScanner? = null

    private var charState: BluetoothGattCharacteristic? = null
    private var charCmd: BluetoothGattCharacteristic? = null
    private var charConfig: BluetoothGattCharacteristic? = null
    private var charDtc: BluetoothGattCharacteristic? = null

    private var intentionalDisconnect = false
    private var autoRecovering = false
    private var reconnectAttempt = 0
    private var connecting = false
    private var scanAttempt = 0

    companion object {
        private const val SCAN_TIMEOUT_MS = 15_000L
        private const val SCAN_RETRY_DELAY_MS = 3_000L
        private const val CONNECT_TIMEOUT_MS = 15_000L
        private const val MAX_RECONNECT_WITH_CACHED_DEVICE = 3
    }

    private val _status = MutableStateFlow("Rozłączono")
    val status: StateFlow<String> = _status.asStateFlow()

    private val _state = MutableStateFlow<StatePacket?>(null)
    val state: StateFlow<StatePacket?> = _state.asStateFlow()

    private val _config = MutableStateFlow<ConfigPacket?>(null)
    val config: StateFlow<ConfigPacket?> = _config.asStateFlow()

    private val _rssi = MutableStateFlow<Int?>(null)
    val rssi: StateFlow<Int?> = _rssi.asStateFlow()

    private val _dtc = MutableStateFlow<String?>(null)
    val dtc: StateFlow<String?> = _dtc.asStateFlow()

    val connected: Boolean get() = gatt != null && device != null

    private val UUID_CCCD: java.util.UUID =
        java.util.UUID.fromString(Gatt.NOTIF_DESC)

    // ------------------------------------------------- kolejka operacji GATT

    private val opQueue = LinkedList<() -> Unit>()
    private var opPending = false

    private fun enqueue(op: () -> Unit) {
        synchronized(opQueue) {
            opQueue.add(op)
            drainQueue()
        }
    }

    private fun opComplete() {
        synchronized(opQueue) {
            opPending = false
            drainQueue()
        }
    }

    private fun drainQueue() {
        if (opPending || opQueue.isEmpty()) return
        opPending = true
        opQueue.removeFirst()()
    }

    private fun resetQueue() {
        synchronized(opQueue) {
            opQueue.clear()
            opPending = false
        }
    }

    // ------------------------------------------------------------------ scan

    fun startScan() {
        if (connecting || gatt != null) return
        cancelScan()
        intentionalDisconnect = false
        scanAttempt++
        _status.value = "Skanowanie…"
        try {
            val bleAdapter = adapter ?: run {
                _status.value = "Bluetooth niedostępny — ponawiam…"
                handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
                return
            }
            val sc = bleAdapter.bluetoothLeScanner ?: run {
                _status.value = "Brak skanera BLE — ponawiam…"
                handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
                return
            }
            scanner = sc
            scanCallback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    val dev = result.device
                    val name = try { dev.name?.lowercase() ?: "" } catch (t: Throwable) { "" }
                    val hasSvc = result.scanRecord
                        ?.serviceUuids?.contains(ParcelUuid(Gatt.SERVICE)) == true
                    if (hasSvc || name.startsWith(Gatt.NAME_PREFIX)) {
                        cancelScan()
                        connectTo(dev)
                    }
                }

                override fun onScanFailed(errorCode: Int) {
                    _status.value = "Błąd skanowania ($errorCode) — ponawiam…"
                    cancelScan()
                    handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
                }
            }
            sc.startScan(scanCallback)
            handler.removeCallbacks(scanTimeoutRunnable)
            handler.postDelayed(scanTimeoutRunnable, SCAN_TIMEOUT_MS)
        } catch (e: SecurityException) {
            scanCallback = null
            scanner = null
            _status.value = "Brak uprawnień BLE — ponawiam…"
            handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
        } catch (t: Throwable) {
            scanCallback = null
            scanner = null
            _status.value = "Bluetooth niedostępny — ponawiam…"
            handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
        }
    }

    private var scanCallback: ScanCallback? = null

    private fun cancelScan() {
        scanCallback?.let { cb ->
            try { scanner?.stopScan(cb) } catch (t: Throwable) {}
        }
        scanCallback = null
        scanner = null
    }

    private val scanTimeoutRunnable = Runnable {
        if (gatt == null && !connecting) {
            _status.value = "Nie znaleziono (próba $scanAttempt) — ponawiam za ${SCAN_RETRY_DELAY_MS / 1000}s…"
            cancelScan()
            handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
        }
    }

    private val rescanRunnable = Runnable {
        handler.removeCallbacks(reconnectRunnable)
        autoRecovering = false
        if (gatt != null || connecting || intentionalDisconnect) return@Runnable
        startScan()
    }

    // --------------------------------------------------------------- connect

    private fun connectTo(dev: BluetoothDevice) {
        if (connecting) return
        connecting = true
        cancelScan()
        device = dev
        handler.removeCallbacks(reconnectRunnable)
        handler.removeCallbacks(connectTimeoutRunnable)
        closeGatt()
        resetQueue()
        _status.value = "Łączenie…"
        var ok = false
        try {
            gatt = dev.connectGatt(context, false, gattCallback,
                BluetoothDevice.TRANSPORT_LE)
            ok = gatt != null
        } catch (t: Throwable) {
            gatt = null
        }
        if (!ok) {
            try {
                gatt = dev.connectGatt(context, false, gattCallback)
                ok = gatt != null
            } catch (t: Throwable) {
                gatt = null
            }
        }
        if (!ok) {
            connecting = false
            _status.value = "Nie udało się połączyć — ponawiam…"
            handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
            return
        }
        handler.postDelayed(connectTimeoutRunnable, CONNECT_TIMEOUT_MS)
    }

    private val connectTimeoutRunnable = Runnable {
        if (connecting) {
            connecting = false
            closeGatt()
            resetQueue()
            _status.value = "Połączenie nie odpowiedziało (${CONNECT_TIMEOUT_MS / 1000}s) — ponawiam skan…"
            startScan()
        }
    }

    private fun autoReconnectAfterFailure(msg: String) {
        _status.value = "$msg — ponawiam…"
        connecting = false
        handler.removeCallbacks(connectTimeoutRunnable)
        autoRecovering = true
        try { gatt?.disconnect() } catch (_: Throwable) {}
        closeGatt()
        resetQueue()
        handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
    }

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    reconnectAttempt = 0
                    handler.removeCallbacks(connectTimeoutRunnable)
                    _status.value = "Połączono, negocjacja MTU…"
                    connecting = false
                    try {
                        g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    } catch (_: Throwable) {}
                    val ok = try { g.requestMtu(247) } catch (_: Throwable) { false }
                    if (!ok) {
                        _status.value = "Połączono, czytanie usług…"
                        g.discoverServices()
                    }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    connecting = false
                    handler.removeCallbacks(connectTimeoutRunnable)
                    _state.value = null
                    _config.value = null
                    _rssi.value = null
                    _dtc.value = null
                    handler.removeCallbacks(rssiRunnable)
                    charState = null
                    charCmd = null
                    charConfig = null
                    charDtc = null
                    resetQueue()
                    if (intentionalDisconnect) {
                        _status.value = "Rozłączono"
                    } else if (gatt == null || autoRecovering) {
                        // Samoczynne leczenie trwa (reskan) — nie podwajaj.
                    } else {
                        scheduleReconnect(status)
                    }
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            _status.value = "Połączono (MTU $mtu), czytanie usług…"
            g.discoverServices()
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                autoReconnectAfterFailure("Błąd usług ($status)")
                return
            }
            val svc = g.getService(Gatt.SERVICE) ?: run {
                autoReconnectAfterFailure("Brak usługi olejarki")
                return
            }
            charState = svc.getCharacteristic(Gatt.STATE)
            charCmd = svc.getCharacteristic(Gatt.CMD)
            charConfig = svc.getCharacteristic(Gatt.CONFIG)
            charDtc = svc.getCharacteristic(Gatt.DTC)

            enqueue { subscribe(g, charState) }
            enqueue { subscribe(g, charConfig) }
            enqueue { readOne(g, charConfig) }
            enqueue { readOne(g, charState) }

            _status.value = "Połączono"
            scheduleRssiPoll()
        }

        override fun onDescriptorWrite(
            g: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            opComplete()
        }

        override fun onReadRemoteRssi(g: BluetoothGatt, rssi: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                _rssi.value = rssi
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicWrite(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            opComplete()
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            dispatch(characteristic, value)
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            dispatch(characteristic, characteristic.value ?: ByteArray(0))
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                dispatch(characteristic, value)
            }
            opComplete()
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                dispatch(characteristic, characteristic.value ?: ByteArray(0))
            }
            opComplete()
        }
    }

    private fun dispatch(ch: BluetoothGattCharacteristic, value: ByteArray) {
        when (ch.uuid) {
            Gatt.STATE -> _state.value = StatePacket.parse(value)
            Gatt.CONFIG -> _config.value = ConfigPacket.parse(value)
            Gatt.DTC -> _dtc.value = String(value, Charsets.UTF_8).trim()
            else -> {}
        }
    }

    // ------------------------------------------ subscribe / read (pojedynczo)

    private fun subscribe(g: BluetoothGatt, ch: BluetoothGattCharacteristic?) {
        if (ch == null) {
            opComplete()
            return
        }
        if (ch.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0) {
            opComplete()
            return
        }
        try {
            g.setCharacteristicNotification(ch, true)
            val desc = ch.getDescriptor(UUID_CCCD)
            if (desc == null) {
                opComplete()
                return
            }
            desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            g.writeDescriptor(desc)
        } catch (t: Throwable) {
            opComplete()
        }
    }

    private fun readOne(g: BluetoothGatt, ch: BluetoothGattCharacteristic?) {
        if (ch == null) {
            opComplete()
            return
        }
        if (ch.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0) {
            opComplete()
            return
        }
        try {
            g.readCharacteristic(ch)
        } catch (t: Throwable) {
            opComplete()
        }
    }

    // ------------------------------------------------- komendy do ch_cmd_ble

    fun sendCommand(cmd: String) {
        enqueue {
            val g = gatt
            val ch = charCmd
            if (g == null || ch == null) {
                opComplete()
                return@enqueue
            }
            val props = ch.properties
            if (props and (BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) == 0
            ) {
                opComplete()
                return@enqueue
            }
            try {
                ch.writeType = if (props and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                } else {
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                }
                ch.value = cmd.toByteArray(Charsets.UTF_8)
                if (!g.writeCharacteristic(ch)) opComplete()
            } catch (t: Throwable) {
                opComplete()
            }
        }
    }

    fun sendSet(key: String, value: Int) = sendCommand(Gatt.set(key, value))

    fun sendDate() {
        val now = Calendar.getInstance()
        sendCommand(Gatt.date(now.get(Calendar.YEAR),
            now.get(Calendar.MONTH) + 1, now.get(Calendar.DAY_OF_MONTH)))
    }

    fun requestDtc() {
        _dtc.value = null
        sendCommand(Gatt.DTC_READ_CMD)
        handler.postDelayed({ readDtcChar() }, 500L)
        handler.postDelayed({ readDtcChar() }, 1500L)
    }

    fun requestState() {
        enqueue {
            val g = gatt
            val ch = charState
            if (g == null || ch == null) {
                opComplete()
                return@enqueue
            }
            readOne(g, ch)
        }
    }

    fun clearDtc() {
        _dtc.value = null
        sendCommand(Gatt.DTC_CLEAR_CMD)
        handler.postDelayed({ readDtcChar() }, 500L)
        handler.postDelayed({ readDtcChar() }, 1500L)
    }

    private fun readDtcChar() {
        enqueue {
            val g = gatt
            val ch = charDtc
            if (g == null || ch == null) {
                opComplete()
                return@enqueue
            }
            readOne(g, ch)
        }
    }

    // ------------------------------------------------------------- disconnect

    fun disconnect() {
        intentionalDisconnect = true
        autoRecovering = false
        connecting = false
        cancelScan()
        handler.removeCallbacks(reconnectRunnable)
        handler.removeCallbacks(rescanRunnable)
        handler.removeCallbacks(scanTimeoutRunnable)
        handler.removeCallbacks(connectTimeoutRunnable)
        resetQueue()
        try { gatt?.disconnect() } catch (t: Throwable) {}
        closeGatt()
        _status.value = "Rozłączono"
        _state.value = null
        _config.value = null
        _rssi.value = null
        _dtc.value = null
        handler.removeCallbacks(rssiRunnable)
    }

    private fun closeGatt() {
        try { gatt?.close() } catch (t: Throwable) {}
        gatt = null
    }

    // --------------------------------------------------------------- reconnect

    private val reconnectRunnable = Runnable {
        val dev = device
        if (dev != null && !intentionalDisconnect) {
            _status.value = "Ponawianie połączenia (${reconnectAttempt + 1})…"
            connectTo(dev)
        }
    }

    private fun scheduleReconnect(status: Int) {
        closeGatt()
        reconnectAttempt++
        if (reconnectAttempt > MAX_RECONNECT_WITH_CACHED_DEVICE) {
            _status.value = "Nie mogę połączyć się z zapamiętanym urządzeniem — ponawiam skan…"
            handler.postDelayed(rescanRunnable, SCAN_RETRY_DELAY_MS)
            return
        }
        val delay = (3000L + reconnectAttempt * 2000L).coerceAtMost(15000L)
        _status.value = "Rozłączono ($status), ponawiam za ${delay / 1000}s…"
        handler.postDelayed(reconnectRunnable, delay)
    }

    // ------------------------------------------------------------- siła sygnału

    private val rssiRunnable: Runnable = Runnable {
        val g = gatt
        if (g == null || device == null) {
            _rssi.value = null
            return@Runnable
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                g.readRemoteRssi()
            } catch (_: Throwable) {
            }
        }
        handler.postDelayed(rssiRunnable, 2000L)
    }

    private fun scheduleRssiPoll() {
        handler.removeCallbacks(rssiRunnable)
        handler.post(rssiRunnable)
    }
}

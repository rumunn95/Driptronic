package pl.olejarka

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/** Profil GATT olejarki TRK 702X — 1:1 z firmware ESPHome. */
object Gatt {
    val SERVICE = UUID.fromString("6e40f001-b5a3-f393-e0a9-e50e24dcca9e")
    val STATE   = UUID.fromString("6e40f002-b5a3-f393-e0a9-e50e24dcca9e")
    val CMD     = UUID.fromString("6e40f003-b5a3-f393-e0a9-e50e24dcca9e")
    val INFO    = UUID.fromString("6e40f004-b5a3-f393-e0a9-e50e24dcca9e")
    val CONFIG  = UUID.fromString("6e40f005-b5a3-f393-e0a9-e50e24dcca9e")
    val DTC     = UUID.fromString("6e40f006-b5a3-f393-e0a9-e50e24dcca9e")

    const val NOTIF_DESC = "00002902-0000-1000-8000-00805f9b34fb"
    const val NAME_PREFIX = "olejarka"

    // Klucze SET (pakiet ch_config_ble 22B + ch_cmd_ble)
    object Cfg {
        const val CEL = "CEL"          // interwał [impulsy]
        const val ZAWOR = "ZAWOR"      // czas otwarcia zaworu [ms]
        const val POMPC = "POMPC"      // czas pompki [ms]
        const val POMPI = "POMPI"      // impulsy pompki [imp]
        const val LIMIT = "LIMIT"      // limit dzienny [imp]
        const val OBWOD = "OBWOD"      // obwód koła [cm]
        const val VMIN = "VMIN"        // min prędkość [km/h]
        const val WYDAJ = "WYDAJ"      // wydajność pompki [ml/1000 imp]
        const val POJEMN = "POJEMN"    // pojemność zbiornika [ml]
        const val AWARYJNY = "AWARYJNY"// interwał awaryjny [min]
        const val TYP = "TYP"          // typ siłownika: 0 = elektrozawór, 1 = pompka
        const val KALI = "KALI"        // kalibracja temp. zewn. [°C, krok 0.5]
        const val FCAL = "FCAL"        // kalibracja paliwa [%]
        const val DCAL = "DCAL"        // kalibracja dystansu [%]
    }

    // Akcje / komendy bez argumentów (ch_cmd_ble)
    const val AUTO_ON = "AUTO_ON"
    const val AUTO_OFF = "AUTO_OFF"
    const val RAIN_ON = "RAIN_ON"
    const val RAIN_OFF = "RAIN_OFF"
    // Tryby dawki — mnożnik czasu pracy pompki (wymaga obsługi w firmware;
    // echo trybu: flags bity 8-9 w pakiecie stanu).
    const val DOSE_ECO = "DOSE_ECO"          // ×0.6
    const val DOSE_NORMAL = "DOSE_NORMAL"    // ×1.0 (domyślny)
    const val DOSE_TURBO = "DOSE_TURBO"      // ×1.5
    const val BLEED_ON = "BLEED_ON"
    const val BLEED_OFF = "BLEED_OFF"
    const val LUBS = "LUBS"            // dawka remanentowa (twarda pompka)
    const val AP = "AP"                // tryb AP (fallback/test)
    const val WIFI = "WIFI"            // powrót na WiFi
    const val RST_TRIP = "RST_TRIP"    // zero trip
    const val RST_FUEL = "RST_FUEL"    // zero zużycia paliwa HUD
    const val RST_FUEL_LVL = "RST_FUEL_LVL" // ustaw poziom paliwa na pełny zbiornik
    const val RST_DAILY = "RST_DD"     // zero dawki dziennej
    const val RST_TOTAL = "RST_DT"     // zero dawki całkowitej
    const val RST_USAGE_DAILY = "RST_ZD" // zero zużycia oleju dziennego
    const val RST_USAGE_TOTAL = "RST_ZT" // zero zużycia oleju całkowitego
    const val RST_IMP = "RST_IMP"      // zero licznika impulsów
    const val DTC_CMD = "DTC"            // UDS: sesja rozszerzona (0x10 0x03)
    const val DTC_READ_CMD = "DTC_READ"    // UDS: ReadDTCInformation (0x19 0x02)
    const val DTC_CLEAR_CMD = "DTC_CLR"  // UDS: ClearDiagnosticInformation (0x14)

    /** `SET <klucz> <wartość>` — komenda zapisu parametru. */
    fun set(key: String, value: Int): String = "SET $key $value"

    /** `DATE YYYYMMDD` — synchronizacja daty RTC. */
    fun date(y: Int, m: Int, d: Int): String =
        "DATE " + "%04d%02d%02d".format(y, m, d)
}

/**
 * Pakiet stanu ch_state_ble — 50 bajtów (little-endian), notify 1×/s.
 * Mapowanie pozycji 1:1 z YAML (override_state_packet).
 */
data class StatePacket(
    val seq: Long,                // licznik pakietów — wymusza emisję nawet przy identycznych danych
    val speedKph: Float,          // 0..3  int32  /10
    val impulses: Long,           // 4..7  uint32
    val progressPct: Int,         // 8..9  u16
    val dosesToday: Long,         // 10..13 uint32
    val dosesTotal: Long,         // 14..17 uint32
    val usageTodayMl: Float,      // 18..21 uint32 /10
    val usageTotalMl: Float,      // 22..25 uint32 /10
    val oilMl: Long,              // 26..29 uint32
    val tempC: Float?,            // 30..31 int16  /10, 0x7FFF = brak
    val flags: Int,               // 32..33 u16
    val obdRpm: Int,              // 34..35 int16
    val obdCoolantC: Float?,      // 36..37 int16  /10, 0x7FFF = brak
    val fuelRateLh: Float,        // 38..39 u16 /100
    val fuelTotalL: Float,        // 40..41 u16 /1000
    val distanceKm: Float,        // 42..43 u16 /100 (przez OBD/load)
    val loadPct: Int,             // 44 u8
    val throttlePct: Int,         // 45 u8
    val tripKm: Float,            // 46..49 uint32 /1000
    val fuelLevelL: Float,        // 50..51 u16 /1000 (poziom paliwa 0..20 L)
) {
    val lampOn: Boolean get() = flags and 1 != 0        // bit0 = typ siłownika (Pompka Webasto)
    val autoOn: Boolean get() = flags and 2 != 0        // AUTO_ON
    val apOnly: Boolean get() = flags and 4 != 0        // tryb AP
    val lastEmergency: Boolean get() = flags and 8 != 0 // bit3 = ost. smarowanie awaryjne
    val emergencyPending: Boolean get() = flags and 16 != 0 // bit4 = oczekuje smarowanie awaryjne
    val emergencyMode: Boolean get() = flags and 32 != 0    // bit5 = tryb awaryjny aktywny
    val bleedOn: Boolean get() = flags and 64 != 0      // odpowietrzanie
    val rainOn: Boolean get() = flags and 128 != 0      // tryb deszcz
    val speedFromObd: Boolean get() = flags and 1024 != 0 // bit10 = prędkość z OBD (0 = hall)
    // bity 8-9: tryb dawki (0 = brak/niewspierane, 1 = Eco, 2 = Normal, 3 = Turbo)
    val doseMode: Int? get() = ((flags ushr 8) and 3).let { if (it == 0) null else it - 1 }
    val oilLow: Boolean get() = oilMl < 250

    companion object {
        private const val T_NONE = 0x7FFF
        private var counter = 0L

        fun parse(bytes: ByteArray?): StatePacket? {
            if (bytes == null || bytes.size < 52) return null
            val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

            val tempRaw = bb.getShort(30).toInt()
            val coolantRaw = bb.getShort(36).toInt()

            return StatePacket(
                seq = ++counter,
                speedKph = bb.getInt(0) / 10f,
                impulses = bb.getInt(4).toLong() and 0xFFFFFFFFL,
                progressPct = bb.getShort(8).toInt() and 0xFFFF,
                dosesToday = bb.getInt(10).toLong() and 0xFFFFFFFFL,
                dosesTotal = bb.getInt(14).toLong() and 0xFFFFFFFFL,
                usageTodayMl = (bb.getInt(18).toLong() and 0xFFFFFFFFL) / 10f,
                usageTotalMl = (bb.getInt(22).toLong() and 0xFFFFFFFFL) / 10f,
                oilMl = bb.getInt(26).toLong() and 0xFFFFFFFFL,
                tempC = if (tempRaw == T_NONE) null else tempRaw / 10f,
                flags = bb.getShort(32).toInt() and 0xFFFF,
                obdRpm = bb.getShort(34).toInt(),
                obdCoolantC = if (coolantRaw == T_NONE) null else coolantRaw / 10f,
                fuelRateLh = (bb.getShort(38).toInt() and 0xFFFF) / 100f,
                fuelTotalL = (bb.getShort(40).toInt() and 0xFFFF) / 1000f,
                distanceKm = (bb.getShort(42).toInt() and 0xFFFF) / 100f,
                loadPct = bb.get(44).toInt() and 0xFF,
                throttlePct = bb.get(45).toInt() and 0xFF,
                tripKm = (bb.getInt(46).toLong() and 0xFFFFFFFFL) / 1000f,
                fuelLevelL = (bb.getShort(50).toInt() and 0xFFFF) / 1000f,
            )
        }
    }
}

/**
 * Pakiet konfiguracji ch_config_ble — 22 bajty (11 × u16 LE) na starym firmware,
 * 24 bajty (12 × u16) po dodaniu kalibracji temp. (KALI),
 * 26 bajtów (13 × u16) po dodaniu kalibracji paliwa (FCAL),
 * 28 bajtów (14 × u16) po dodaniu kalibracji dystansu (DCAL). Kolejność 1:1 z YAML.
 */
data class ConfigPacket(
    val intervalImp: Int,          // CEL
    val valveOpenMs: Int,          // ZAWOR
    val pumpRunMs: Int,            // POMPC
    val pumpImp: Int,              // POMPI
    val dailyLimitImp: Int,        // LIMIT
    val wheelCircumCm: Int,        // OBWOD
    val minSpeedKph: Int,          // VMIN
    val pumpFlowMlPer1k10: Int,    // WYDAJ ×10 (np. 225 = 22,5 ml/1000 imp)
    val tankCapacityMl: Int,       // POJEMN
    val emergencyMin: Int,         // AWARYJNY
    val actuatorType: Int,         // TYP
    val tempCal10: Int = 0,        // KALI — offset temp. zewn. ×10 (int16), 0 gdy brak
    val fuelCalX100: Int = 100,    // FCAL — korekta zużycia paliwa [%], 100 = bez zmian
    val distCalX100: Int = 100,    // DCAL — korekta dystansu [%], 100 = bez zmian
) {
    val pumpFlowMlPer1k: Float get() = pumpFlowMlPer1k10 / 10f
    val pumpFlowMl: Float get() = pumpFlowMlPer1k / 100f
    val tempCalC: Float get() = tempCal10 / 10f

    companion object {
        fun parse(bytes: ByteArray?): ConfigPacket? {
            if (bytes == null || bytes.size < 22) return null
            val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            return ConfigPacket(
                intervalImp = bb.getShort(0).toInt() and 0xFFFF,
                valveOpenMs = bb.getShort(2).toInt() and 0xFFFF,
                pumpRunMs = bb.getShort(4).toInt() and 0xFFFF,
                pumpImp = bb.getShort(6).toInt() and 0xFFFF,
                dailyLimitImp = bb.getShort(8).toInt() and 0xFFFF,
                wheelCircumCm = bb.getShort(10).toInt() and 0xFFFF,
                minSpeedKph = bb.getShort(12).toInt() and 0xFFFF,
                pumpFlowMlPer1k10 = bb.getShort(14).toInt() and 0xFFFF,
                tankCapacityMl = bb.getShort(16).toInt() and 0xFFFF,
                emergencyMin = bb.getShort(18).toInt() and 0xFFFF,
                actuatorType = bb.getShort(20).toInt() and 0xFFFF,
                tempCal10 = if (bytes.size >= 24) bb.getShort(22).toInt() else 0,
                fuelCalX100 = if (bytes.size >= 26) bb.getShort(24).toInt() and 0xFFFF else 100,
                distCalX100 = if (bytes.size >= 28) bb.getShort(26).toInt() and 0xFFFF else 100,
            )
        }
    }
}

/** Formatowanie pomocnicze do wyświetlania. */
object Fmt {
    fun speed(v: Float): String = "%.1f".format(v)
    fun ml(v: Float): String = "%.0f".format(v)
    fun ml1(v: Float): String = "%.1f".format(v)
    fun km(v: Float): String = if (v >= 100) "%.0f".format(v) else "%.1f".format(v)
    fun l(v: Float): String = if (v >= 10) "%.1f".format(v) else "%.2f".format(v)
    fun pct(v: Int): String = "$v%"
    fun temp(v: Float?): String = v?.let { "%.1f°C".format(it) } ?: "--"
}
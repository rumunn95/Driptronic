package pl.olejarka

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder

/**
 * Usługa monitorowana w tle podczas aktywnej jazdy.
 *
 * Podnosi priorytet procesu (ogranicza ucięcia) i pokazuje trwałe
 * powiadomienie. Start/stop sterowane z MainActivity na podstawie pakietów
 * stanu (speed >= 5 km/h). Typ dataSync — zgodny z Android 14+.
 */
class RideService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.ensureChannels(this)
        startForeground(Notifier.NOTIFICATION_RIDE_ID, Notifier.ride(this))
        return START_STICKY
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        fun start(context: Context) {
            context.startForegroundService(Intent(context, RideService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RideService::class.java))
        }
    }
}
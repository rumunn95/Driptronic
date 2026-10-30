package pl.olejarka

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Powiadomienia olejarki.
 *
 * Kanał [CHANNEL_ALERT] — alerty (rozłączenie BLE, niski olej, wysoka CHT,
 * podsumowanie tripu) z dźwiękiem i wibracją.
 * Kanał [CHANNEL_RIDE] — trwała informacja podczas aktywnej jazdy
 * (foreground service).
 */
object Notifier {
    const val CHANNEL_ALERT = "olejarka-alert"
    const val CHANNEL_RIDE = "olejarka-ride"
    const val NOTIFICATION_RIDE_ID = 1001

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ALERT,
                "Alerty olejarki",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Rozłączenie BLE, niski olej, wysoka temperatura, podsumowanie tripu"
                enableVibration(true)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RIDE,
                "Trasa",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Trwająca jazda — monitorowanie"
                setShowBadge(false)
            }
        )
    }

    private fun mainIntent(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    fun alert(context: Context, title: String, text: String, vibrate: Boolean = true) {
        try {
            if (vibrate) vibrate(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val n = Notification.Builder(context, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(mainIntent(context))
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)
                .build()
            nm.notify((System.currentTimeMillis() % 100000).toInt(), n)
        } catch (t: Throwable) {
        }
    }

    fun ride(context: Context): Notification =
        Notification.Builder(context, CHANNEL_RIDE)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Jazda — śledzenie tripu")
            .setContentText("Trwa zbieranie danych o trasie")
            .setContentIntent(mainIntent(context))
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW)
            .build()

    private fun vibrate(context: Context) {
        try {
            val v: Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager)
                    .defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            v.vibrate(VibrationEffect.createOneShot(250, VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (t: Throwable) {
        }
    }
}
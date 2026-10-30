package pl.olejarka

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Czyta powiadomienia nawigacji (Google Maps, Yanosik, Mapy.com), żeby HUD mógł
 * pokazać „za ile skręcić" w kolumnie OBD, gdy wybrany jest Podgląd nawigacji.
 *
 * Wymaga zgody „Dostęp do powiadomień" w systemowych ustawieniach telefonu
 * (apka przekierowuje tam przyciskiem w Ustawieniach → 🎛 Kafelki HUD).
 */
class NavNotifyListener : NotificationListenerService() {

    companion object {
        /** Mostek do WebView ustawiany przez MainActivity; bezpieczny dla wielu wątków. */
        @Volatile
        var sink: ((String, String, String) -> Unit)? = null

        /** Pakiety nawigacji, których powiadomienia przekazujemy do HUD. */
        val NAV_PACKAGES = setOf(
            "com.google.android.apps.maps",     // Google Maps
            "pl.neptis.yanosik.mobi.android",   // Yanosik
            "cz.seznam.mapy"                    // Mapy.com (Mapy.cz, Seznam)
        )

        /** Sentinel dla WebView: system ukrył treść powiadomienia (redakcja). */
        const val REDACTED = "__REDACTED__"

        /**
         * Placeholder systemowej redakcji: „Treść poufnego powiadomienia została ukryta"
         * (i odpowiedniki). Przychodzi, gdy telefon jest zablokowany albo gdy ustawienia
         * nakazują ukrywać poufne treści — nie jest to prawdziwa instrukcja nawigacji.
         */
        private val REDACTED_RE = Regex(
            "(?i)(poufnego powiadomienia|została ukryta|zostało ukryte|treść.{0,40}ukryt|" +
                "notification.{0,50}hidden|content.{0,50}hidden|private notification|sensitive notification)"
        )

        private fun isRedacted(vararg parts: String): Boolean =
            parts.any { REDACTED_RE.containsMatchIn(it) }

        /**
         * Komunikaty serwisowe nawigacji (np. „Działa. Naciśnij, aby otworzyć.",
         * gdy mapa pracuje w tle) — to nie jest wskazanie trasy,
         * więc nie nadpisują karty (zastępowałyby prawdziwą instrukcję).
         */
        private val SERVICE_RE = Regex(
            "(?i)(naci[śs]nij.{0,40}otw[óo]rz|dotknij.{0,40}otw[óo]rz|otw[óo]rz.{0,40}naci[śs]nij|" +
                "tap.{0,50}(to )?open|press.{0,50}(to )?open|swipe.{0,50}(to )?open|touch.{0,50}(to )?open|" +
                "wr[óo]c.{0,30}nawigacj|return.{0,30}(to )?navigation)"
        )

        private fun isServiceNotice(vararg parts: String): Boolean =
            parts.any { SERVICE_RE.containsMatchIn(it) }
    }

    private fun describe(sbn: StatusBarNotification): Pair<String, String>? {
        val n = sbn.notification ?: return null
        val e = n.extras
        val title = (e.getCharSequence(Notification.EXTRA_TITLE)
            ?: e.getCharSequence(Notification.EXTRA_TITLE_BIG))?.toString()?.trim()
        var text = (e.getCharSequence(Notification.EXTRA_TEXT)
            ?: e.getCharSequence(Notification.EXTRA_BIG_TEXT))?.toString()?.trim()
        if (text.isNullOrEmpty()) {
            // Niektóre nawigacje potrafią wysłać treść wyłącznie jako linie
            // lub podtytuł — próbujemy z tych pól, zanim uznamy powiadomienie za puste.
            val lines = e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                ?.mapNotNull { it?.toString()?.trim() }
                ?.filter { it.isNotEmpty() }
            if (!lines.isNullOrEmpty()) text = lines.joinToString("\n")
            else text = e.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()
        }
        if (title.isNullOrEmpty() && text.isNullOrEmpty()) return null
        return title.orEmpty() to text.orEmpty()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null || sbn.packageName !in NAV_PACKAGES) return
        val d = describe(sbn) ?: return
        // Komunikat serwisowy (np. „Działa. Naciśnij, aby otworzyć.") to nie
        // wskazanie trasy — ignorujemy go, żeby nie nadpisywał karty prawdziwą
        // instrukcją ani nie czyścił jej na „Brak nawigacji".
        if (isServiceNotice(d.first, d.second)) return
        if (isRedacted(d.first, d.second)) {
            // Treść ukryta przez system — przekazujemy flagę zamiast placeholdera,
            // żeby HUD nie wyświetlał go jako instrukcji (i nie sugerował skrętu).
            sink?.invoke(sbn.packageName, REDACTED, "")
            return
        }
        sink?.invoke(sbn.packageName, d.first, d.second)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        if (sbn == null || sbn.packageName !in NAV_PACKAGES) return
        // Nawigacja zakończona/zamknięta — czyścimy kartę.
        sink?.invoke(sbn.packageName, "", "")
    }
}
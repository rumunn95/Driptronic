# Olejarka TRK 702X — natywna aplikacja Android

Natywna apka (Kotlin + Jetpack Compose) komunikująca się z olejarką **wyłącznie po BLE**:
HUD (pakiet stanu 50 B) + pełne ustawienia (pakiet config 22 B + `SET <klucz>`).
WiFi pełni tylko rolę testu/fallbacku (tryb AP) oraz OTA firmware — nie jest potrzebna do pracy apki.

## Wymagania

- Android Studio **Quail 4** (lub nowsza stabilna) — https://developer.android.com/studio
- Telefon: Android 8+ (minSdk 26), Bluetooth LE
- Kompilacja z wiersza poleceń: `gradlew assembleDebug`

## Otwarcie i budowa

1. Kopiujesz folder `olejarka-android/` na komputer z Android Studio.
2. Android Studio: **Open** → wskaż katalog `olejarka-android` (to root projektu).
3. Pierwsza synchronizacja Gradle pobierze AGP/Gradle/Compose automatycznie (internet potrzebny raz).
4. `Build` → `Make Project` albo Terminal: `./gradlew assembleDebug`.
5. Telefon: *Ustawienia → Developer options → USB debugging* + podłącz USB.
6. `Run` na telefonie; przy pierwszym uruchomieniu zaakceptuj uprawnienia Bluetooth.

> Debug build ma suffiks `.debug` w package (`pl.olejarka.trk702x.debug`),
> więc spokojnie stoi obok ewentualnej wersji production.

## Struktura

| Plik | Rola |
|------|------|
| `app/src/main/java/pl/olejarka/GattProfile.kt` | UUID, pakiety `StatePacket` (50 B) i `ConfigPacket` (22 B), komendy |
| `app/src/main/java/pl/olejarka/BleManager.kt` | skan → połączenie, notify, auto-reconnect |
| `app/src/main/java/pl/olejarka/MainActivity.kt` | UI: HUD + Ustawienia, immersive fullscreen |
| `docs/GATT.md` | pełna specyfikacja protokołu (1:1 z YAML) |

## Co już działa

- Skanowanie po identyfikatorze usługi (`6e40f001`) + nazwa `olejarka` — pierwsze połączenie bez dodatkowego parowania
- Subskrypcja `state` (notify 500 ms) i `config` (notify 1 s) + odczyt początkowy
- HUD: prędkość, trip, dawki, zużycie oleju, poziom oleju, OBD (obr./min, chłodzenie, paliwo), DESZCZ/AUTO
- Ustawienia: zmiana parametrów przez `SET`, przełączniki AUTO/DESZCZ, odpowietrzanie, resety, `DATE`, testowe AP/WiFi
- Immersive: pełny ekran bez pasków, bez żadnych gestów (przeglądarka tego nie umiała)

## Praca z firmware (dla informacji)

- Firmware 1:1 w kodzie `Gatt.kt` — zmiana YAML wymaga aktualizacji UUID/pakietów w `GattProfile.kt`
- Kompilację i wgrywanie firmware robi wyłącznie Romek (decyzja 2026-09-06)
- Punkty powrotu: `backup-20260911-v101-aktualna-punkt-powrotu` (PWA v1.01 przed apką)
# Protokół GATT — Olejarka TRK 702X (ESPHome)

Wersja protokołu: **GATT v2** (informacja zwracana przez `ch_info_ble`).
Mapowanie 1:1 z `esphome/olejarka-trk-702x.yaml` (blok `esp32_ble_server`, ~wiersz 26).

## Usługa

| Usługa                       | UUID |
|------------------------------|--------------------------------------|
| usługa olejarki              | `6e40f001-b5a3-f393-e0a9-e50e24dcca9e` (advertise) |

## Charakterystyki

| Char | UUID | Uprawnienia | Format | Częstotliwość |
|------|------|-------------|--------|---------------|
| `ch_state_ble`  | `6e40f002-…` | read + notify | 50 B LE | notify co 500 ms |
| `ch_cmd_ble`    | `6e40f003-…` | write, write_no_response | tekst UTF-8 | na żądanie |
| `ch_info_ble`   | `6e40f004-…` | read | `"Olejarka TRK 702X \| ESPHome \| GATT v2"` | — |
| `ch_config_ble` | `6e40f005-…` | read + notify | 22 B LE | notify co 1 s |
| `ch_dtc_ble`    | `6e40f006-…` | read | tekst UTF-8 (kody DTC) | na żądanie |

CCCD (`00002902`) na `ch_state_ble` i `ch_config_ble` celem włączenia notify.
MTU: domyślne lub `requestMtu(247)` (i tak mieszczą się pakiety 50/22 B).

## Pakiet stanu — `ch_state_ble` (50 bajtów, little-endian)

| Off | Roz | Typ | Pole | Skala |
|-----|-----|-----|------|-------|
| 0  | 4 | int32 | prędkość | /10 → km/h (0 gdy brak impulsów > 2 s) |
| 4  | 4 | uint32 | aktualne impulsy licznika | — |
| 8  | 2 | uint16 | postęp dawki do CEL | % (0–100, cel połowiony w trybie DESZCZ) |
| 10 | 4 | uint32 | liczba dawek dziś | — |
| 14 | 4 | uint32 | liczba dawek łącznie | — |
| 18 | 4 | uint32 | zużycie oleju dziś | /10 → ml |
| 22 | 4 | uint32 | zużycie oleju łącznie | /10 → ml |
| 26 | 4 | uint32 | poziom oleju w zbiorniku | ml |
| 30 | 2 | int16 | temp. zewn. (olej) | /10 → °C; `0x7FFF` = brak |
| 32 | 2 | uint16 | flagi (patrz niżej) | — |
| 34 | 2 | int16 | obroty silnika (OBD) | 1/min |
| 36 | 2 | int16 | temp. płynu (OBD) | /10 → °C; `0x7FFF` = brak |
| 38 | 2 | uint16 | chwilowe spalanie (OBD) | /100 → l/h |
| 40 | 2 | uint16 | paliwo zużyte (OBD) | /1000 → l |
| 42 | 2 | uint16 | przebieg (OBD) | /100 → km |
| 44 | 1 | uint8 | obciążenie silnika (OBD) | % |
| 45 | 1 | uint8 | pozycja pedału (OBD) | % |
| 46 | 4 | uint32 | trip | /1000 → km |

### Bajty flag (offset 32–33, uint16 LE)

| Bit | Znaczenie |
|-----|-----------|
| 0   | siłownik aktywny (`actuator == 1`) — lampka/awaria |
| 1   | tryb AUTO włączony |
| 2   | tryb AP_ONLY aktywny |
| 3   | tryb awaryjny aktywny (`ost_awaryjne`) |
| 4   | `pending_emergency` |
| 5   | interwał awaryjny > 0 ustawiony |
| 6   | zawór oleju otwarty (aktywne smarowanie) |
| 7   | tryb DESZCZ włączony |

## Pakiet konfiguracji — `ch_config_ble` (22 bajty = 11 × uint16 LE)

| Off | Klucz SET | Pole | Uwagi |
|-----|-----------|------|-------|
| 0  | `CEL`      | interwał dawki | impulsy |
| 2  | `ZAWOR`    | czas otwarcia zaworu | ms |
| 4  | `POMPC`    | czas pracy pompki | ms |
| 6  | `POMPI`    | liczba impulsów pompki | impulsy |
| 8  | `LIMIT`    | max dawek dziennie | impulsy |
| 10 | `OBWOD`    | obwód koła | cm |
| 12 | `VMIN`     | min. prędkość zadziałania | km/h |
| 14 | `WYDAJ`    | wydajność pompki | ml / 1000 imp |
| 16 | `POJEMN`   | pojemność zbiornika | ml |
| 18 | `AWARYJNY` | interwał awaryjny | min (Wył.=0) |
| 20 | `TYP`      | typ siłownika | 0 = Elektrozawór, 1 = Pompka Webasto |

## Komendy — `ch_cmd_ble` (tekst UTF-8)

Aktywne natychmiast; znak walki `'\r'`/`'\n'`/`'\0'` z końca jest odcinany.

### Akcje bez argumentów

| Komenda | Działanie |
|--------|-----------|
| `LUBS` | twarde smarowanie (zawór otwarty) |
| `BLEED_ON` / `BLEED_OFF` | odpowietrzanie |
| `AP` | przełącz w tryb AP (fallback/test) |
| `WIFI` | powrót z AP na WiFi |
| `AUTO_ON` / `AUTO_OFF` | tryb automatyczny |
| `RAIN_ON` / `RAIN_OFF` | tryb deszcz |
| `RST_TRIP` | zero trip |
| `RST_FUEL` | zero paliwa (OBD) i przebiegu |
| `RST_DD` | zero dawek dziennych |
| `RST_DT` | zero dawek całkowitych |
| `RST_ZD` | zero zużycia oleju dziennego |
| `RST_ZT` | zero zużycia oleju całkowitego |
| `RST_OIL` | napełnij stan zbiornika do pojemności |
| `RST_IMP` | zero licznika impulsów |
| `DTC` | UDS: wejdź w sesję rozszerzoną (0x10 0x03) |
| `DTC_READ` | UDS: ReadDTCInformation (0x19 0x02) — wynik w `ch_dtc_ble` |
| `DTC_CLR` | UDS: ClearDiagnosticInformation (0x14) |

## Odczyt błędów — `ch_dtc_ble`

Sekwencja: wyślij `DTC`, po ~300 ms `DTC_READ`, następnie odczytaj `ch_dtc_ble`
(~900 ms i ew. ponów). Kasowanie: `DTC` → `DTC_CLR` → odczyt. Zwracany tekst:

- `OK` — brak kodów błędów (albo potwierdzenie kasowania)
- `ERR` — negatywna odpowiedź ECU (NRC), np. wymagany Security Access
- `P0133,P0171,…` — lista kodów (rozdzielona przecinkami), format SAE J2012
  (`P`/`C`/`B`/`U` + 4 cyfry hex), dekodowane z UDS 3-bajtowych DTC
- pusta — jeszcze nie ma wyniku (ponów odczyt)

Firmware wysyła po CAN na adres **fizyczny `0x7E0` → `0x7E8`** (UDS / ISO 14229,
ISO-TP ISO 15765-2, ramki pojedyncze i wieloramkowe). **Nie używa OBD-II
Mode 03/04** — BOSCH MSE6.0 w TRK 702 nie obsługuje ich (zwraca negatywną
odpowiedź), a kod błędów czyta się usługą UDS 0x19/0x14.

### `SET <KLUCZ> <WARTOŚĆ>` — zapis parametru (klucze jak w tabeli config)

- `AWARYJNY` akceptuje tylko `0, 5, 10, 15, 30, 60` (min); każda inna wartość = Wył.
- `TYP` przyjmuje wartość `0`/`1` (0 = Elektrozawór, ≥1 = Pompka Webasto).

### `DATE YYYYMMDD` — synchronizacja daty/RTC

Np. `DATE 20260911`. Zmiana daty (względem zapamiętanej) resetuje liczniki dobowe
(dawki, pulsy, zużycie) — to naturalny „koniec dnia".

## Uwagi implementacyjne (aplikacja)

- Po połączeniu: odczyt `ch_state_ble`, `ch_config_ble`, `ch_info_ble`, subskrypcja notify.
- Wszystkie liczby little-endian, bez znaku tam gdzie zaznaczono `uint*`.
- Brak temperatury = `0x7FFF`, też dla OBD (`0x7FFF`).
- Do planu: rozszerzenie pakietu `config` o `temp_cal_offset` (kalibracja czujnika)
  i `fuel_cal` (mnożnik spalania) — do wdrożenia w YAML + rekompilacja (Romek).
- Tryb AP pozostaje komendą testową/fallback; docelowo ma zniknąć (decyzja 2026-09-11).
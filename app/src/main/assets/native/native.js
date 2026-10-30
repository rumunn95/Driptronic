(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let state = null;
  // Tryby jazdy — kolejność przycisku „Tryb jazdy" na HUD.
  // Eco/Normal/Turbo to dawki (mnożnik porcji względem interwału z ustawień),
  // Rain to tryb deszczowy (interwał skrócony do 50%). Komendy DOSE_* / RAIN_*.
  const RIDE_MODES = [
    { id: "ECO",    kind: "dose", mlt: 0.6,  label: "Tryb: Eco",    sub: "porcja ×0,6",  toast: "Tryb Eco — mała porcja (×0,6): ok. 2 krople na 5 km, oszczędza olej" },
    { id: "NORMAL", kind: "dose", mlt: 1.0,  label: "Tryb: Normal", sub: "porcja ×1,0",  toast: "Tryb Normal — standard (×1,0): 2 krople na 3 km — twój obecny stan" },
    { id: "RAIN",   kind: "rain", mlt: null, label: "Tryb: Rain",   sub: "interwał 50%", toast: "Tryb Rain — mokra nawierzchnia: interwał skrócony do 50%" },
    { id: "TURBO",  kind: "dose", mlt: 1.5,  label: "Tryb: Turbo",  sub: "porcja ×1,5",  toast: "Tryb Turbo — duża porcja (×1,5): ok. 3 krople na 3 km, na teren i kurz" }
  ];
  let modeIdx = 1; // Normal
  // Zapamiętane po id; migracja starego zapisu liczbowego (0=Eco, 1=Normal, 2=Turbo).
  try {
    const saved = localStorage.getItem("olejarDose");
    const legacy = { "0": "ECO", "1": "NORMAL", "2": "TURBO" };
    const id = legacy[saved] || saved;
    const found = id ? RIDE_MODES.findIndex((m) => m.id === id) : -1;
    if (found >= 0) modeIdx = found;
  } catch (e) {}
  let config = null;
  let connected = false;
  // Data (DATE YYYYMMDD) ma być zsynchronizowana do olejarki przy pierwszym pakiecie
  // stanu po (re)połączeniu — to gwarantuje zerowanie liczników dziennych przy zmianie dnia.
  let dateSyncPending = true;
  // Znacznik ostatniej synchronizacji zegara (widoczny obok przycisku „Synchronizuj datę").
  let dateSyncAt = 0;
  let locked = true;
  let kmHints = [];
  let autoTheme = false;
  let themeThr = 2000;
  let themeHyst = 500;
  let themeLightState = null;
  let autoDark = "amoled";
  let lastLux = null;
  let autoBright = false;
  let brMin = 20;
  let brMax = 100;
  let brMul = 100;
  let lastBrightSent = null;
  let luxSmooth = null;
  let lastBrightMs = 0;
  let alerts = { bt: true, oil: true, temp: true };
  let alertLatches = { oil: false, temp: false, chain: false };
  let lastAlertAt = 0;
  let oilAlertMl = 15;
  // Pulpit: statystyki długoterminowe (niezależne od resetów przy tankowaniu) + serwis łańcucha.
  let pulpitStats = { km: 0, fuelL: 0, oilMl: 0 };
  let pBase = { odo: NaN, fuel: NaN, oil: NaN };
  let chainLastKm = NaN;
  let chainIntKm = 400;
  let pulpitSaveAt = 0;
  // Tankowania: historia + auto-kalibracja FCAL (paliwo).
  const REFUEL_KEY = "olejarRefuels";
  // Wartość zwracana przez askInput po wciśnięciu „POMIŃ" (np. cena za litr paliwa)
  // — odróżniona od null (ANULUJ) i od pustego pola (też „bez ceny").
  const REFUEL_SKIP = "__SKIP__";
  const REFUEL_FCAL_KEY = "olejarFcalAuto";
  let refuels = [];              // [{t, odo, liters, price, l100, cost, fuelTotal, dist, fcalFrom, fcalTo}]
  let lastRefuel = null;         // ostatnie tankowanie (punkt odniesienia dla delt)
  let fcalAuto = { factor: null }; // ostatnia auto-korekta FCAL (do cofnięcia)
  let fcalManualHold = false;    // true = użytkownik ustawił FCAL ręcznie, auto nie nadpisuje do najbliższego tankowania
  // Alarm wypadku (crash): wykrywanie po przechyle/OBD/telefonie + eskalacja SMS.
  const CRASH_KEY = "olejarCrash";
  let crashCfg = { on: true, nums: [], delay: 30, layers: 3, call: true, repeat: 3, testAt: 0, callIdx: 0 };
  let crashState = { armed: false, latched: false, at: 0, count: 0, timer: null, smsTimer: null, lastMoveMs: 0, movingSince: 0, stateAt: 0, stoppedSince: 0, moveHits: 0, armedAt: 0, gPeak: 0, lastGMs: 0, muteUntil: 0, gpsMovingSince: 0, lastFastMs: 0, tiltBlocked: false };
  let vuCfg = { lean: 60, y: 0, x: 0 };
  let mapOffline = false;
  let mapCacheCount = 0;
  try {
    const a = JSON.parse(localStorage.getItem("olejarAlerts") || "null");
    if (a && typeof a === "object") alerts = Object.assign({}, alerts, a);
  } catch (e) { /* ignore */ }
  try {
    const om = parseInt(localStorage.getItem("olejarOilLevelMl") || "15", 10);
    if (Number.isFinite(om)) oilAlertMl = Math.max(5, Math.min(60, Math.round(om / 5) * 5));
  } catch (e) { /* ignore */ }
  try {
    const v = JSON.parse(localStorage.getItem("olejarVuCfg") || "null");
    if (v && typeof v.lean === "number") {
      vuCfg = { lean: Math.max(10, Math.min(120, v.lean)), y: Math.max(-80, Math.min(80, v.y || 0)), x: Math.max(-80, Math.min(80, v.x || 0)) };
    }
  } catch (e) { /* ignore */ }
  try {
    mapOffline = localStorage.getItem("olejarMapOffline") === "1";
  } catch (e) { /* ignore */ }
  pulpitLoad();
  refuelLoad();
  crashLoad();
  // tileLoad() celowo NIE tutaj — używa const TILE_DEFAULTS zdefiniowanego niżej (TDZ).
  const CHART_META = {
    load: { label: "LOAD", unit: "%", color: "#3fb950", dec: 0 },
    throttle: { label: "TPS", unit: "%", color: "#3b82f6", dec: 0 },
    progress: { label: "POSTĘP", unit: "%", color: "#d29922", dec: 0 },
    rpm: { label: "OBROTY", unit: " obr", color: "#f778ba", dec: 0 },
    speed: { label: "KM/H", unit: " km/h", color: "#9ecbff", dec: 0 },
    coolant: { label: "SILNIK", unit: " °C", color: "#f47067", dec: 1 },
    oil: { label: "OLEJ", unit: " ml", color: "#f0883e", dec: 0 },
    usageToday: { label: "OLEJ DZIŚ", unit: " ml", color: "#b48cea", dec: 0 },
    fuel: { label: "ZUŻYCIE", unit: " L/h", color: "#e3b341", dec: 1 },
    tilt: { label: "PRZECHYŁ", unit: "°", color: "#56d4dd", dec: 1 },
  };
  const PCT_KEYS = ["load", "throttle", "progress"];
  const CHART_MAX_POINTS = 14400;
  const CHART_SAMPLE_MS = 500;
  const CHART_FINE_MS = 2 * 3600000;
  const CHART_HIST_MS = 60000;
  const CHART_HIST_DAYS = 7;
  const CHART_CUTOFF_MS = CHART_HIST_DAYS * 86400000;
  let liveTilt = Number.NaN;
  let hudTiltSmooth = Number.NaN;
  let hudTiltPeak = 0;
  let hudTiltPeakAt = 0;
  const HUD_PEAK_HOLD_MS = 4000;
  let chartBuf = { load: [], throttle: [], fuel: [], progress: [], rpm: [], speed: [], coolant: [], oil: [], usageToday: [], tilt: [] };
  let chartHist = { load: [], throttle: [], fuel: [], progress: [], rpm: [], speed: [], coolant: [], oil: [], usageToday: [], tilt: [] };
  let chartActive = new Set(["load"]);
  let chartRangeMin = 1440;
  const CHART_DEFAULT_RANGE_MIN = "1440";
  let chartLastSampleAt = 0;
  let chartPin = false;
  let chartT0 = 0;
  let chartProbe = null;
  let chartGeo = null;
  let chartT1 = 0;
  let chartDayN = null;
  let chartDayStart = 0;
  let chartDayEnd = 0;
  const CHART_VIEW_MIN_MS = 30000;
  const CHART_VIEW_MAX_MS = CHART_CUTOFF_MS;
  const HIST_KEY = "olejarHistV1";
  const TRIPS_KEY = "olejarTripsV1";
  const TRIPS_LIVE_KEY = "olejarTripsLiveV1";
  const TRIPS_MAX_DAYS = 20;
  let histSaveTimer = null;
  function markHistDirty() {
    if (histSaveTimer) return;
    histSaveTimer = setTimeout(() => {
      histSaveTimer = null;
      try {
        const out = {};
        for (const k in chartHist) {
          out[k] = chartHist[k].map((b) => [b.t, b.min, b.max, b.last]);
        }
        localStorage.setItem(HIST_KEY, JSON.stringify(out));
      } catch (e) { /* ignore quota */ }
    }, 15000);
  }
  function histPush(k, epoch, v) {
    if (!Number.isFinite(v)) return;
    const b = Math.floor(epoch / CHART_HIST_MS) * CHART_HIST_MS;
    const arr = chartHist[k];
    const cut = Date.now() - CHART_CUTOFF_MS;
    if (arr.length && arr[0].t < cut) {
      while (arr.length && arr[0].t < cut) arr.shift();
    }
    let cur = arr.length && arr[arr.length - 1].t === b ? arr[arr.length - 1] : null;
    if (!cur) {
      arr.push(cur = { t: b, min: v, max: v, last: v });
    } else {
      if (v < cur.min) cur.min = v;
      if (v > cur.max) cur.max = v;
      cur.last = v;
    }
  }
  function flushHist() {
    if (histSaveTimer) { clearTimeout(histSaveTimer); histSaveTimer = null; }
    try {
      const out = {};
      for (const k in chartHist) {
        out[k] = chartHist[k].map((b) => [b.t, b.min, b.max, b.last]);
      }
      localStorage.setItem(HIST_KEY, JSON.stringify(out));
    } catch (e) { /* ignore quota */ }
  }
  const CAL_MIN = 50, CAL_MAX = 500, CAL_STEP = 10;
  let calTestImp = 200;
  let calTimer = null;
  try {
    const v = parseInt(localStorage.getItem("olejarCalImp") || "", 10);
    if (!isNaN(v)) calTestImp = Math.min(CAL_MAX, Math.max(CAL_MIN, v));
  } catch (e) { /* ignore */ }
  try {
    const raw = JSON.parse(localStorage.getItem("olejarHistV1") || "null");
    if (raw && typeof raw === "object") {
      const cut = Date.now() - CHART_CUTOFF_MS;
      for (const k in chartHist) if (Array.isArray(raw[k])) {
        chartHist[k] = raw[k]
          .filter((b) => Array.isArray(b) && b.length >= 4 && b[0] >= cut)
          .map((b) => ({ t: b[0], min: b[1], max: b[2], last: b[3] }));
      }
    }
  } catch (e) { /* ignore */ }

  $("gauge").innerHTML = HUD_MARKUP();

  function bridge() {
    return window.AndroidBle || null;
  }

  function nativeNotifyAlert(title, text, force) {
    const b = bridge();
    if (!b || !b.notifyAlert) return;
    const nowMs = Date.now();
    // Throttling 30 s chroni przed spamem alertów, ale potwierdzenia zapisu paliwa
    // („Zatankowano" itd.) są jedynym feedbackiem — muszą pokazać się zawsze.
    if (!force && nowMs - lastAlertAt < 30000) return;
    lastAlertAt = nowMs;
    try { b.notifyAlert(String(title), String(text)); } catch (e) { /* ignore */ }
  }

  function command(value) {
    const b = bridge();
    if (b && b.sendCommand) b.sendCommand(value);
  }

  function askConfirm(message, danger, okLabel, title, cancelLabel) {
    return new Promise((resolve) => {
      const dialog = $("confirmDialog");
      $("confirmMessage").textContent = message;
      $("confirmTitle").textContent = title || "Reset licznika";
      const kickerEl = document.querySelector("#confirmDialog .confirm-kicker");
      if (kickerEl) kickerEl.textContent = "POTWIERDZENIE";
      const ok = $("confirmOk");
      ok.hidden = false;
      ok.classList.toggle("danger", !!danger);
      ok.textContent = okLabel || (danger ? "ZERUJ" : "RESETUJ");
      $("confirmCancel").textContent = cancelLabel || "ANULUJ";
      dialog.hidden = false;
      const finish = (result) => {
        dialog.hidden = true;
        ok.onclick = null;
        $("confirmCancel").onclick = null;
        resolve(result);
      };
      ok.onclick = () => finish(true);
      $("confirmCancel").onclick = () => finish(false);
      dialog.onclick = (event) => { if (event.target === dialog) finish(false); };
    });
  }

  function askInput(message, placeholder, mode, value, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const dialog = $("confirmDialog");
      $("confirmMessage").textContent = message;
      $("confirmTitle").textContent = opts.title || "Olejarka";
      const kickerEl = document.querySelector("#confirmDialog .confirm-kicker");
      if (kickerEl) kickerEl.textContent = opts.kicker || "POTWIERDZENIE";
      const ok = $("confirmOk");
      ok.hidden = false;
      ok.classList.remove("danger");
      ok.textContent = opts.ok || "OK";
      $("confirmCancel").textContent = opts.cancel || "ANULUJ";
      // Klasa „with-input" = klawiatura w tle — okienko przypina się do góry ekranu
      // i kurczy, żeby klawiatura nie zasłaniała pola i przycisków. Działa też przy
      // klawiaturze PŁYWAJĄCEJ (niepełna szerokość): apka skraca WebView o wysokość
      // klawiatury, a strona trzyma kartę w górnej części ekranu.
      dialog.classList.add("with-input");
      // visualViewport podaje realną wysokość widocznej części strony; przy klawiaturze
      // pływającej na niektórych WebView bywa bezużyteczny, więc wynik traktujemy jako
      // wskazówkę, a kartę i tak przypinamy do góry.
      const vv = window.visualViewport;
      const fitViewport = () => {
        if (!vv) return;
        dialog.style.top = Math.round(vv.offsetTop) + "px";
        dialog.style.bottom = "auto";
        dialog.style.height = Math.round(vv.height) + "px";
      };
      if (vv) {
        vv.addEventListener("resize", fitViewport);
        vv.addEventListener("scroll", fitViewport);
        fitViewport();
      }
      dialog.hidden = false;
      const input = document.createElement("input");
      input.className = "confirm-input";
      input.type = "text";
      // Tryb klawiatury: "text" = normalna (podpisy), "tel" = klawiatura telefonu, domyślnie "decimal".
      input.inputMode = (mode === "text" || mode === "textno") ? "text" : (mode === "tel" ? "tel" : "decimal");
      if (mode === "text") input.autocapitalize = "words";
      // "textno" = tekst bez autokapitalizacji (SSID, hasło) — klawiatura nie zmienia wpisanej nazwy.
      if (mode === "textno") {
        input.autocapitalize = "none";
        input.autocomplete = "off";
        input.spellcheck = false;
      }
      input.placeholder = placeholder || "";
      if (value != null) input.value = String(value);
      $("confirmCard").querySelectorAll(".confirm-input").forEach((x) => x.remove());
      $("confirmCard").insertBefore(input, $("confirmActions"));
      // Opcjonalny trzeci przycisk (np. „POMIŃ" przy cenie paliwa) — rozwiązuje się
      // ze zmienną specjalną (nie null; null = ANULUJ całego okna). Klasa „has-skip"
      // każe przyciskom dzielić wiersz po równo (3 × 132 px nie mieści się na wąskim
      // ekranie). „ZAPISZ" zostaje ostatnim dzieckiem = przycisk główny (CSS).
      let skipBtn = null;
      if (opts.skip) {
        skipBtn = document.createElement("button");
        skipBtn.type = "button";
        skipBtn.textContent = opts.skip;
        $("confirmActions").insertBefore(skipBtn, ok);
        $("confirmActions").classList.add("has-skip");
      }
      const finish = (result) => {
        if (skipBtn) skipBtn.remove();
        $("confirmActions").classList.remove("has-skip");
        input.remove();
        dialog.classList.remove("with-input");
        if (vv) {
          vv.removeEventListener("resize", fitViewport);
          vv.removeEventListener("scroll", fitViewport);
        }
        dialog.style.top = "";
        dialog.style.bottom = "";
        dialog.style.height = "";
        dialog.hidden = true;
        ok.onclick = null;
        $("confirmCancel").onclick = null;
        dialog.onclick = null;
        resolve(result);
      };
      const submit = () => finish(input.value.trim());
      ok.onclick = submit;
      if (skipBtn) skipBtn.onclick = () => finish(REFUEL_SKIP);
      $("confirmCancel").onclick = () => finish(null);
      dialog.onclick = (event) => { if (event.target === dialog) finish(null); };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      setTimeout(() => {
        // Bez scrollIntoView — karta jest już przypięta do góry, a przewijanie
        // na środek wsuwało pole pod klawiaturę.
        input.focus();
      }, 50);
    });
  }

  function bindLongReset(element, commandName, message, after) {
    if (!element) return;
    let timer = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    element.addEventListener("pointerdown", () => {
      // W trybie edycji HUD resety są wyłączone — dotknięcie ma wybierać kafelek, nie zerować.
      if (typeof hudEditMode !== "undefined" && hudEditMode) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        askConfirm(message, false, "TAK", undefined, "NIE").then((accepted) => { if (accepted) { if (typeof after === "function") after(); else command(commandName); } });
      }, 800);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((event) => {
      element.addEventListener(event, clear);
    });
    element.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  function setValue(key, value) {
    const b = bridge();
    if (!b || !b.sendSet) return;
    const num = Math.round(value * 10) / 10;
    b.sendSet(key, String(num));
  }

  function fmtNum(value) {
    if (!Number.isFinite(value)) return "—";
    return String(Math.round(value * 10) / 10);
  }

  function fmtInput(value) {
    if (!Number.isFinite(value)) return "";
    const r = Math.round(value * 100) / 100;
    return String(r).replace(".", ",");
  }

  function fmt(value, decimals) {
    if (!Number.isFinite(value)) return "—";
    return value.toFixed(decimals).replace(".", ",");
  }

  function setArc(id, value) {
    const el = $(id);
    if (!el) return;
    const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
    el.style.strokeDasharray = pct.toFixed(1) + " 100";
    el.style.stroke = pct < 50 ? "var(--accent)" : pct < 80 ? "var(--warn)" : "var(--danger)";
  }

  const TANK_LITERS = 20;
  const TEMP_MIN = 20;
  const TEMP_MAX = 120;

  function setVBar(id, pct, danger) {
    const el = $(id);
    if (!el) return;
    pct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    el.style.height = pct.toFixed(1) + "%";
    const color = danger
      ? (pct < 25 ? "var(--danger)" : pct < 50 ? "var(--warn)" : "var(--accent)")
      : (pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warn)" : "var(--accent)");
    el.style.background = color;
    el.style.color = color;
  }

  function tempColor(t) {
    if (t < 80) return "var(--hud-blue)";
    if (t <= 95) return "var(--accent)";
    return "var(--danger)";
  }

  function fuelColor(lvl) {
    if (lvl < 12) return "var(--danger)";
    if (lvl < 25) return "var(--warn)";
    return "var(--accent)";
  }

  function updateVBars(s) {
    const tmpEl = $("hudTempBarVal");
    if (Number.isFinite(s.obdCoolant)) {
      const pct = (s.obdCoolant - TEMP_MIN) / (TEMP_MAX - TEMP_MIN) * 100;
      const col = tempColor(s.obdCoolant);
      const fill = $("hudTempFill");
      if (fill) {
        fill.style.height = pct.toFixed(1) + "%";
        fill.style.background = col;
      }
      if (tmpEl) {
        const show = s.obdCoolant >= 40;
        tmpEl.textContent = show ? String(Math.round(s.obdCoolant)) + "°C" : "";
        tmpEl.style.bottom = Math.max(50, Math.min(92, pct)).toFixed(1) + "%";
        tmpEl.style.color = col;
        tmpEl.classList.toggle("show", show);
      }
    } else {
      const fill = $("hudTempFill");
      if (fill) { fill.style.height = "0%"; fill.style.background = "var(--hud-blue)"; }
      if (tmpEl) tmpEl.classList.remove("show");
    }

    const fEl = $("hudFuelBarVal");
    const levelProvided = Number.isFinite(s.fuelLevel);
    const remain = levelProvided ? s.fuelLevel : (Number.isFinite(s.fuelTotal) ? TANK_LITERS - s.fuelTotal : NaN);
    if (Number.isFinite(remain)) {
      const lvl = remain / TANK_LITERS * 100;
      const col = fuelColor(lvl);
      const ffill = $("hudFuelFill");
      if (ffill) {
        ffill.style.height = Math.max(0, Math.min(100, lvl)).toFixed(1) + "%";
        ffill.style.background = col;
      }
      if (fEl) {
        fEl.textContent = remain > 0 ? fmt(Math.max(0, remain), 1) + " L" : "0,0 L";
        const pos = Math.max(51, Math.min(92, lvl));
        fEl.style.bottom = pos.toFixed(1) + "%";
        fEl.style.color = col;
        fEl.classList.add("show");
      }
    } else {
      const ffill = $("hudFuelFill");
      if (ffill) { ffill.style.height = "0%"; ffill.style.background = "var(--accent)"; }
      if (fEl) fEl.classList.remove("show");
    }
  }

  function doseUi(dm) {
    const mode = $("hudMode");
    if (!mode) return;
    mode.classList.toggle("rain", dm.id === "RAIN");
    mode.querySelector(".hud-mode-label").textContent = dm.label;
    mode.querySelector(".hud-mode-sub").textContent = dm.sub;
  }

  let modeToastTimer = null;
  function showModeToast(text) {
    const t = $("modeToast");
    if (!t) return;
    t.textContent = text;
    t.classList.add("show");
    if (modeToastTimer) clearTimeout(modeToastTimer);
    modeToastTimer = setTimeout(() => { t.classList.remove("show"); modeToastTimer = null; }, 4000);
  }

  function updateHud(s) {
    if (!s) return;
    // Kafelki OBD/OLEJARKA/TRIP/ZASIĘG są teraz rysowane przez tileRender (edytowalne).
    $("hudSpeed").textContent = Number.isFinite(s.speed) ? String(Math.round(s.speed)) : "—";
    $("hudProgressVal").textContent = Number.isFinite(s.pct) ? Math.round(s.pct) + "%" : "—%";
    $("hudLoadVal").textContent = Number.isFinite(s.load) ? Math.round(s.load) + "%" : "—%";
    $("hudThrVal").textContent = Number.isFinite(s.throttle) ? Math.round(s.throttle) + "%" : "—%";
    $("hudZuz").innerHTML = fmt(s.zd, 1) + " ml <i class='hud-z-tag'>dziś</i> · " +
      fmt(s.zt, 1) + " ml <i class='hud-z-tag'>łącznie</i>";
    setArc("hudGaugeFill", s.speed * 100 / 160);
    setArc("hudArcFill", s.pct);
    setArc("hudLoadArc", s.load);
    setArc("hudThrArc", s.throttle);
    updateVBars(s);
    const mode = $("hudMode");
    // s.rain ma priorytet (może pochodzić też z przycisku DESZCZ); inaczej tryb
    // z firmware (s.dose 0/1/2 = Eco/Normal/Turbo), a gdy brak — z wyboru lokalnego.
    const doseIds = ["ECO", "NORMAL", "TURBO"];
    let dm = RIDE_MODES[modeIdx] || RIDE_MODES[1];
    if (s.rain) dm = RIDE_MODES.find((m) => m.id === "RAIN") || dm;
    else if (Number.isFinite(s.dose) && doseIds[s.dose]) dm = RIDE_MODES.find((m) => m.id === doseIds[s.dose]) || dm;
    mode.classList.toggle("rain", dm.id === "RAIN");
    mode.querySelector(".hud-mode-label").textContent = dm.label;
    mode.querySelector(".hud-mode-sub").textContent = dm.sub;
    $("autoBtn").textContent = "AUTO: " + (s.auto ? "ON" : "OFF");
    $("rainBtn").textContent = "DESZCZ: " + (s.rain ? "ON" : "OFF");
    const spdSrc = $("spdSrcBtn");
    if (spdSrc) spdSrc.textContent = "PRĘDKOŚĆ: " + (s.spdObd ? "OBD" : "HALL");
    $("hudPump").classList.toggle("pumping", !!s.pumping);
    $("hudPump").querySelector(".hud-pump-label").textContent = s.pumping ? "Pompuję…" : "Smaruj teraz";
    sampleCharts(s);
    renderWarnings(s);
    alertsCheck(s);
    updatePulpit(s);
    tileRender(s);
  }

  function sampleCharts(s) {
    const now = performance.now();
    if (now - chartLastSampleAt < CHART_SAMPLE_MS) return;
    chartLastSampleAt = now;
    const epoch = Date.now();
    const cutoff = now - CHART_FINE_MS;
    const push = (k, v) => { if (Number.isFinite(v)) { chartBuf[k].push({ t: now, v }); histPush(k, epoch, v); } };
    push("load", s.load);
    push("throttle", s.throttle);
    push("progress", s.pct);
    push("rpm", s.rpm);
    push("speed", s.speed);
    push("coolant", s.obdCoolant);
    push("oil", s.poz);
    push("usageToday", s.zd);
    push("fuel", s.obdFuel);
    for (const key in chartBuf) {
      const arr = chartBuf[key];
      while (arr.length && arr[0].t < cutoff) arr.shift();
      if (arr.length > CHART_MAX_POINTS) arr.splice(0, arr.length - CHART_MAX_POINTS);
    }
    markHistDirty();
    const el = $("chartsLive");
    if (el) {
      el.textContent = "LOAD " + (Number.isFinite(s.load) ? s.load + "%" : "—") +
        "  ·  TPS " + (Number.isFinite(s.throttle) ? s.throttle + "%" : "—") +
        "  ·  OBROTY " + (Number.isFinite(s.rpm) ? s.rpm : "—") +
        "  ·  OLEJ " + (Number.isFinite(s.poz) ? s.poz + " ml" : "—");
    }
  }

  function drawCharts() {
    const cv = $("chartCanvas");
    if (!cv) return;
    const wrap = cv.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) { scheduleDrawCharts(); return; }
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const now = performance.now();
    const off = Date.now() - performance.now();
    let t1;
    let t0;
    if (chartPin) {
      // chartT0/chartT1 są w czasie rzeczywistym; wykres rysujemy w skali performance.
      // Strażnik: przypięty widok nie może zostać na zakresie bez danych.
      const dr = dataRangePerf();
      let e0 = chartT0;
      let e1 = chartT0 + Math.max(CHART_VIEW_MIN_MS, chartT1 - chartT0);
      if (dr) {
        const dLo = dr.lo + off;
        const dHi = dr.hi + off;
        if (e1 < dLo || e0 > dHi) {
          const span = Math.max(CHART_VIEW_MIN_MS, Math.min(e1 - e0, Math.max(1, dHi - dLo)));
          e1 = dHi;
          e0 = Math.max(dLo, e1 - span);
          chartT0 = e0;
          chartT1 = e1;
        }
      }
      t0 = e0 - off;
      t1 = e1 - off;
    } else {
      t1 = now;
      t0 = now - chartRangeMin * 60000;
    }
    const oldest = oldestSampleT();
    if (t0 < oldest && !chartPin) t0 = oldest;
    const rangeMs = Math.max(CHART_VIEW_MIN_MS, t1 - t0);
    const selected = Object.keys(CHART_META).filter((k) => chartActive.has(k));
    const hasPct = selected.some((k) => PCT_KEYS.includes(k));
    const autoKeys = selected.filter((k) => !PCT_KEYS.includes(k));
    const padL = 44;
    const padR = autoKeys.length && hasPct ? 46 : 12;
    const padT = 34;
    const padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const px = (t) => padL + ((t - t0) / rangeMs) * plotW;

    const histToPerf = (e) => e - off;
    const histPoints = (k, eFrom, eTo) => {
      const cols = Math.max(2, Math.floor(plotW));
      const cw = (eTo - eFrom) / cols;
      const columns = new Array(cols);
      for (const b of chartHist[k]) {
        if (b.t < eFrom) continue;
        if (b.t >= eTo) break;
        const c = Math.floor((b.t - eFrom) / cw);
        if (c < 0 || c >= cols) continue;
        if (!columns[c]) columns[c] = { min: Infinity, max: -Infinity, last: 0 };
        const col = columns[c];
        if (b.min < col.min) col.min = b.min;
        if (b.max > col.max) col.max = b.max;
        col.last = b.last;
      }
      const pts = [];
      for (let c = 0; c < cols; c++) {
        const col = columns[c];
        if (!col) continue;
        pts.push({ t: histToPerf(eFrom + cw * (c + 0.5)), v: col.last, min: col.min, max: col.max });
      }
      return pts;
    };

    const series = {};
    let any = false;
    const fine = rangeMs <= CHART_FINE_MS;
    // Bufor "fine" (chartBuf) to tylko ostatnie 2 h na żywo. Używamy go wyłącznie,
    // gdy okno faktycznie sięga teraźniejszości — przy przeglądaniu historii
    // (wybrany dzień, przewijanie) rysujemy z chartHist, żeby nie było "porwanego" wykresu.
    const bufUsable = fine && t1 + off >= Date.now() - CHART_FINE_MS && t0 + off <= Date.now();
    for (const k of selected) {
      let pts = [];
      if (bufUsable) {
        for (const p of chartBuf[k]) if (p.t >= t0 - 1 && p.t <= t1 + 1) pts.push({ t: p.t, v: p.v, min: p.v, max: p.v });
        if (pts.length < 2) pts = histPoints(k, t0 + off, t1 + off);
      } else {
        pts = histPoints(k, t0 + off, t1 + off);
      }
      series[k] = pts;
      if (pts.length >= 2) any = true;
    }
    const empty = $("chartsEmpty");
    if (!any) {
      // Zachowaj geometrię nawet przy braku danych — inaczej gesty/probe tracą punkt odniesienia
      // i nie da się wrócić do zakresu z danymi.
      chartGeo = { w, h, padL, padR, padT, padB, plotW, plotH, px, scales: {}, series, selected, rangeMs, t0, t1, fine };
      empty.hidden = false;
      if (chartActive.has("tilt") && !Number.isFinite(liveTilt) && fine) {
        empty.textContent = "PRZECHYŁ: wciśnij „Kalibruj poziom” (Ustawienia → Czujnik przechyłu)";
      } else {
        empty.textContent = "Brak danych w tym zakresie";
      }
      return;
    }
    empty.hidden = true;

    const scales = {};
    for (const k of selected) {
      if (PCT_KEYS.includes(k)) { scales[k] = { min: 0, max: 100 }; continue; }
      if (k === "tilt") {
        let maxA = 0;
        for (const p of series[k]) maxA = Math.max(maxA, Math.abs(p.min), Math.abs(p.max));
        const M = Math.max(1, Math.ceil(maxA * 1.1));
        scales[k] = { min: -M, max: M };
        continue;
      }
      let maxV = 0;
      for (const p of series[k]) if (p.max > maxV) maxV = p.max;
      scales[k] = { min: 0, max: Math.max(1, Math.ceil(maxV * 1.1)) };
    }
    const pyFor = (k) => {
      const sc = scales[k];
      return (v) => padT + (1 - (v - sc.min) / Math.max(1, sc.max - sc.min)) * plotH;
    };
    chartGeo = { w, h, padL, padR, padT, padB, plotW, plotH, px, scales, series, selected, rangeMs, t0, t1, fine };

    ctx.strokeStyle = "rgba(139,148,158,.16)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    }

    const leftKey = hasPct ? selected.find((k) => PCT_KEYS.includes(k)) : (autoKeys.length ? autoKeys[0] : "load");
    const leftScale = scales[leftKey];
    const skipZero = leftKey !== "tilt";
    const axisFmt = (k, v) => {
      if (k === "tilt") return Math.round(v) + "°";
      return CHART_META[k].dec === 1 ? v.toFixed(1) : String(Math.round(v));
    };
    ctx.fillStyle = "rgba(139,148,158,.85)";
    ctx.font = "500 10px sans-serif";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const v = leftScale.max - ((leftScale.max - leftScale.min) * i) / 4;
      const gy = padT + (plotH * i) / 4;
      const txt = axisFmt(leftKey, v);
      if (skipZero && Math.round(v) === 0) continue;
      ctx.fillText(txt, padL - 7, gy + 3);
    }
    if (hasPct && autoKeys.length) {
      const fs = scales[autoKeys[0]];
      ctx.textAlign = "left";
      for (let i = 0; i <= 4; i++) {
        const v = fs.max - (fs.max * i) / 4;
        const gy = padT + (plotH * i) / 4;
        ctx.fillText(" " + axisFmt(autoKeys[0], v), w - padR + 6, gy + 3);
      }
    }

    const epoch = (t) => Date.now() + (t - now);
    const multDay = rangeMs > 20 * 3600000;
    const timeFmt = (epochMs) => new Date(epochMs).toLocaleString("pl-PL",
      multDay ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
              : { hour: "2-digit", minute: "2-digit" });
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const t = t0 + (rangeMs * i) / 4;
      const gx = padL + (plotW * i) / 4;
      ctx.fillText(timeFmt(epoch(t)), gx, h - 7);
    }

    // Pasmo min/max pokazujemy tylko dla pierwszej zaznaczonej serii — przy wielu
    // seriach nakładające się pasma zlewały się w tło i zasłaniały przebieg.
    const bandKey = selected.length ? selected[0] : null;
    for (const k of selected) {
      const s = series[k];
      if (s.length < 2) continue;
      const meta = CHART_META[k];
      const py = pyFor(k);
      const pts = s.map((p) => ({ x: px(p.t), y: py(p.v) }));
      if (!fine) {
        if (k === bandKey) {
          const band = s.map((p) => ({ x: px(p.t), yU: py(p.max), yD: py(p.min) }));
          ctx.save();
          ctx.globalAlpha = 0.10;
          ctx.fillStyle = meta.color;
          ctx.beginPath();
          ctx.moveTo(band[0].x, band[0].yU);
          for (let i = 1; i < band.length; i++) ctx.lineTo(band[i].x, band[i].yU);
          for (let i = band.length - 1; i >= 0; i--) ctx.lineTo(band[i].x, band[i].yD);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 0.40;
          ctx.lineWidth = 1;
          ctx.strokeStyle = meta.color;
          ctx.beginPath();
          ctx.moveTo(band[0].x, band[0].yU);
          for (let i = 1; i < band.length; i++) ctx.lineTo(band[i].x, band[i].yU);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(band[0].x, band[0].yD);
          for (let i = 1; i < band.length; i++) ctx.lineTo(band[i].x, band[i].yD);
          ctx.stroke();
          ctx.restore();
        }
      } else {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, meta.color + "30");
        grad.addColorStop(1, meta.color + "05");
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.lineTo(pts[pts.length - 1].x, padT + plotH);
        ctx.lineTo(pts[0].x, padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      smoothPath(ctx, pts);
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }

    let cy = 8;
    for (const k of selected) {
      const s = series[k];
      if (s.length < 2) continue;
      const meta = CHART_META[k];
      const lastVal = s[s.length - 1].v;
      const header = meta.label + "  " + (meta.dec ? lastVal.toFixed(meta.dec) : Math.round(lastVal)) + meta.unit;
      ctx.font = "800 13px sans-serif";
      const tw = ctx.measureText(header).width;
      const chw = tw + 28;
      if (chw < w) {
        ctx.fillStyle = "rgba(22,27,34,.88)";
        rr(ctx, 10, cy, chw, 24, 8);
        ctx.fill();
        ctx.fillStyle = meta.color;
        ctx.beginPath(); ctx.arc(22, cy + 12, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#e6edf3";
        ctx.textAlign = "left";
        ctx.fillText(header, 32, cy + 16);
        cy += 28;
      }
    }

    drawProbe(ctx);
  }

  function smoothPath(ctx, pts) {
    const n = pts.length;
    if (n < 2) return;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    // Przy rzadkich danych wygładzanie splajnem robi ogromne łuki i wykres wygląda
    // na „porwany". Gdy punkty są daleko od siebie (średni odstęp > ~6 px),
    // rysujemy zwykłą łamaną — wiernie oddaje przebieg.
    const span = xs[n - 1] - xs[0];
    const avgGap = span > 0 ? span / (n - 1) : 0;
    if (avgGap > 6) {
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < n; i++) ctx.lineTo(xs[i], ys[i]);
      return;
    }
    const slopes = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i] || 1e-6;
      slopes.push((ys[i + 1] - ys[i]) / dx);
    }
    const tans = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) tans.push(slopes[0]);
      else if (i === n - 1) tans.push(slopes[n - 2]);
      else if (slopes[i - 1] * slopes[i] < 0) tans.push(0);
      else tans.push((slopes[i - 1] + slopes[i]) / 2);
    }
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 0; i < n - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const c1x = xs[i] + dx / 3;
      const c1y = ys[i] + tans[i] * dx / 3;
      const c2x = xs[i + 1] - dx / 3;
      const c2y = ys[i + 1] - tans[i + 1] * dx / 3;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, xs[i + 1], ys[i + 1]);
    }
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function oldestSampleT() {
    let oldest = Infinity;
    const off = Date.now() - performance.now();
    for (const key in chartBuf) {
      if (chartBuf[key].length) oldest = Math.min(oldest, chartBuf[key][0].t);
    }
    for (const key in chartHist) {
      if (chartHist[key].length) oldest = Math.min(oldest, chartHist[key][0].t - off);
    }
    if (!isFinite(oldest)) oldest = performance.now() - chartRangeMin * 60000;
    return oldest;
  }

  // Zwraca realny przedział czasu (performance.now) obejmujący próbki wybranych serii.
  function dataRangePerf() {
    const off = Date.now() - performance.now();
    const selected = Object.keys(CHART_META).filter((k) => chartActive.has(k));
    let lo = Infinity;
    let hi = -Infinity;
    const consider = (t) => { if (t < lo) lo = t; if (t > hi) hi = t; };
    for (const k of selected) {
      const buf = chartBuf[k];
      if (buf && buf.length) { consider(buf[0].t); consider(buf[buf.length - 1].t); }
      const h = chartHist[k];
      if (h && h.length) { consider(h[0].t - off); consider(h[h.length - 1].t - off); }
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return { lo, hi };
  }

  // Realny przedział czasu próbek wybranych serii, w CZASIE RZECZYWISTYM (Date.now).
  // Cała obsługa wykresu używa jednego zegara (epoch), żeby nie mieszać skal.
  function dataRangeEpoch() {
    const off = Date.now() - performance.now();
    const selected = Object.keys(CHART_META).filter((k) => chartActive.has(k));
    let lo = Infinity;
    let hi = -Infinity;
    const consider = (t) => { if (t < lo) lo = t; if (t > hi) hi = t; };
    for (const k of selected) {
      const buf = chartBuf[k];
      if (buf && buf.length) {
        consider(buf[0].t + off);
        consider(buf[buf.length - 1].t + off);
      }
      const h = chartHist[k];
      if (h && h.length) { consider(h[0].t); consider(h[h.length - 1].t); }
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return { lo, hi };
  }

  // Ustawia okno wykresu w czasie rzeczywistym (epoch), przycinając je do danych.
  // Gdy wybrany jest dzień, okno porusza się wyłącznie w jego granicach.
  function setChartWindow(e0, spanMs) {
    const dateNow = Date.now();
    const dr = dataRangeEpoch();
    // Granice ruchu okna: wybrany dzień, a gdy go nie ma — cały zakres danych.
    let lo = dr ? dr.lo : dateNow - CHART_CUTOFF_MS;
    let hi = Math.min(dateNow, dr ? dr.hi : dateNow);
    if (chartDayStart && chartDayEnd && chartDayEnd > chartDayStart) {
      const dLo = Math.max(lo, chartDayStart);
      const dHi = Math.min(hi, chartDayEnd);
      if (dHi > dLo) { lo = dLo; hi = dHi; }
    }
    const dataSpan = Math.max(1, hi - lo);
    const minSpan = Math.min(CHART_VIEW_MIN_MS, dataSpan);
    const win = Math.max(minSpan, Math.min(Math.max(spanMs, minSpan), dataSpan));
    // Okno mieszczące się w granicach: początek w [lo, hi-win].
    const maxStart = Math.max(lo, hi - win);
    let s0 = Math.min(Math.max(e0, lo), maxStart);
    let s1 = Math.min(hi, s0 + win);
    // Zapadnia: puste okno → przesuń je tak, żeby trafiło w próbki.
    // Ważne: bierzemy ostatnią próbkę W OBRĘBIE granic (dnia), a nie koniec dnia —
    // inaczej okno ląduje po ostatnim zapisie i pokazuje pustkę.
    if (dr) {
      const selected = Object.keys(CHART_META).filter((k) => chartActive.has(k));
      let lastT = -Infinity;
      let firstT = Infinity;
      for (const k of selected) {
        const arr = chartHist[k];
        if (!arr || !arr.length) continue;
        // Znajdź pierwszą i ostatnią próbkę w granicach lo..hi.
        for (let i = 0; i < arr.length; i++) {
          const t = arr[i].t;
          if (t < lo) continue;
          if (t > hi) break;
          if (t < firstT) firstT = t;
          lastT = t;
        }
      }
      const hasSample = (() => {
        if (!isFinite(lastT)) return false;
        for (const k of selected) {
          const arr = chartHist[k];
          for (let i = 0; i < arr.length; i += 7) {
            const t = arr[i].t;
            if (t < s0) continue;
            if (t > s1) break;
            return true;
          }
        }
        return false;
      })();
      if (!hasSample && isFinite(lastT)) {
        s1 = Math.min(hi, lastT);
        s0 = Math.max(lo, s1 - win);
        if (s1 - s0 < minSpan) s1 = Math.min(hi, s0 + minSpan);
      }
    }
    chartPin = true;
    chartT0 = s0;
    chartT1 = Math.min(s1, s0 + CHART_VIEW_MAX_MS);
  }

  function resetChartView() {
    chartPin = false;
    chartT0 = 0;
    chartT1 = 0;
    chartProbe = null;
    chartDayN = null;
    chartDayStart = 0;
    chartDayEnd = 0;
    const label = $("chartDayLabel");
    if (label) label.hidden = true;
  }

  // Zmiana zakresu z listy: okno o zadanej szerokości. Gdy wybrany jest dzień,
  // okno ląduje w jego obrębie (na końcu dnia), a nie „na teraz".
  function applySelection(epochMs) {
    const dateNow = Date.now();
    if (chartDayStart && chartDayEnd && chartDayEnd > chartDayStart) {
      const end = Math.min(chartDayEnd, dateNow);
      setChartWindow(end - epochMs, epochMs);
    } else {
      setChartWindow(dateNow - epochMs, epochMs);
    }
    chartProbe = null;
    drawCharts();
  }

  function liveView() {
    resetChartView();
    const label = $("chartDayLabel");
    if (label) label.hidden = true;
    const scale = $("chartScale");
    if (scale) { scale.value = CHART_DEFAULT_RANGE_MIN; chartRangeMin = 1440; }
    drawCharts();
  }

  function setupChartDate() {
    const input = $("chartDate");
    if (!input) return;
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const minD = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    input.min = minD.getFullYear() + "-" + pad(minD.getMonth() + 1) + "-" + pad(minD.getDate());
    input.max = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
    input.value = input.max;
    input.addEventListener("change", () => {
      const v = input.value;
      if (!v) { liveView(); return; }
      const parts = v.split("-");
      if (parts.length !== 3) return;
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      if (isNaN(d)) return;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dateNow = Date.now();
      const startE = d.getTime();
      const endE = startE + 86400000;
      if (endE <= today.getTime() - CHART_CUTOFF_MS || startE > dateNow) return;
      chartDayN = Math.round((today.getTime() - startE) / 86400000);
      // Granice wybranego dnia — obowiązują przy zmianie zakresu i przesuwaniu.
      chartDayStart = startE;
      chartDayEnd = Math.min(endE, dateNow);
      // chartT0/chartT1 są w czasie rzeczywistym (epoch).
      chartPin = true;
      chartT0 = startE;
      chartT1 = Math.min(endE, dateNow);
      if (chartT1 - chartT0 < CHART_VIEW_MIN_MS) chartT1 = chartT0 + CHART_VIEW_MIN_MS;
      chartProbe = null;
      const label = $("chartDayLabel");
      if (label) {
        label.textContent = chartDayN === 0 ? "Dziś" : new Date(startE).toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "numeric" });
        label.hidden = false;
      }
      const scale = $("chartScale");
      if (scale) { scale.value = CHART_DEFAULT_RANGE_MIN; chartRangeMin = 1440; }
      drawCharts();
    });
  }

  // a, b: czasy w CZASIE RZECZYWISTYM (epoch) — tak samo jak chartT0/chartT1.
  function applyView(a, b) {
    setChartWindow(a, Math.max(CHART_VIEW_MIN_MS, b - a));
    chartProbe = null;
    drawCharts();
  }

  function showProbeAt(xPx) {
    const g = chartGeo;
    if (!g) return;
    const t = g.t0 + ((xPx - g.padL) / Math.max(1, g.plotW)) * g.rangeMs;
    chartProbe = { t: Math.max(g.t0, Math.min(g.t1, t)) };
    drawCharts();
  }

  function drawProbe(ctx) {
    const g = chartGeo;
    if (!chartProbe || !g) return;
    const t = chartProbe.t;
    if (!(t >= g.t0 && t <= g.t1)) { chartProbe = null; return; }
    const x = g.px(t);
    ctx.save();
    ctx.strokeStyle = "rgba(139,148,158,.5)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, g.padT); ctx.lineTo(x, g.padT + g.plotH); ctx.stroke();
    ctx.setLineDash([]);

    const rows = [];
    for (const k of g.selected) {
      const s = g.series[k];
      if (!s.length) continue;
      let best = s[0];
      let bd = Math.abs(best.t - t);
      let mn = Infinity;
      let mx = -Infinity;
      for (const p of s) {
        const d = Math.abs(p.t - t);
        if (d < bd) { bd = d; best = p; }
        if (Number.isFinite(p.min) && p.min < mn) mn = p.min;
        if (Number.isFinite(p.max) && p.max > mx) mx = p.max;
      }
      const meta = CHART_META[k];
      const val = best.v;
      const fmt = (v) => (meta.dec ? v.toFixed(meta.dec) : String(Math.round(v))) + meta.unit;
      rows.push({
        k, color: meta.color, label: meta.label, val: fmt(val),
        mn: Number.isFinite(mn) ? fmt(mn) : "", mx: Number.isFinite(mx) ? fmt(mx) : "",
      });
    }
    if (!rows.length) { ctx.restore(); return; }

    let bw = 0;
    ctx.font = "700 12px sans-serif";
    for (const r of rows) {
      const txt = r.label + "  " + r.val + "   MIN " + r.mn + "  MAX " + r.mx;
      bw = Math.max(bw, ctx.measureText(txt).width);
    }
    bw += 26;
    const rowH = 17;
    const bh = rows.length * rowH + 12;
    let bx = x + 10;
    if (bx + bw > g.w - g.padR) bx = x - bw - 10;
    bx = Math.max(g.padL, bx);
    const by = g.padT + 4;
    ctx.fillStyle = "rgba(22,27,34,.92)";
    rr(ctx, bx, by, bw, bh, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(139,148,158,.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = "left";
    let yy = by + 20;
    for (const r of rows) {
      ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.arc(bx + 12, yy - 4, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#e6edf3";
      ctx.fillText(r.label, bx + 22, yy);
      ctx.fillStyle = r.color;
      ctx.fillText("  " + r.val, bx + 22 + ctx.measureText(r.label).width, yy);
      ctx.fillStyle = "rgba(139,148,158,.9)";
      const pre = r.label + "  " + r.val;
      ctx.fillText("  MIN " + r.mn + "  MAX " + r.mx, bx + 22 + ctx.measureText(pre).width + 6, yy);
      yy += rowH;
    }
    ctx.restore();
  }

  function bindChartsGestures() {
    const cv = $("chartCanvas");
    if (!cv) return;
    const pts = {};
    const downPos = {};
    let gesture = null;
    const keys = () => Object.keys(pts);
    const dist = () => {
      const ids = keys();
      if (ids.length < 2) return 0;
      return Math.hypot(pts[ids[0]].x - pts[ids[1]].x, pts[ids[0]].y - pts[ids[1]].y);
    };
    const plotW = () => cv.clientWidth - 52;
    // Wszystko w CZASIE RZECZYWISTYM (epoch) — jeden zegar, bez mieszania skal.
    const viewSpan = () => Math.max(CHART_VIEW_MIN_MS, chartT1 - chartT0);
    const msPerPx = () => (chartPin ? viewSpan() : chartRangeMin * 60000) / Math.max(1, plotW());
    const startPan = (id) => {
      gesture = {
        kind: "pan",
        id,
        startX: pts[id].x,
        startT0: chartPin ? chartT0 : Date.now() - chartRangeMin * 60000,
        startT1: chartPin ? chartT0 + viewSpan() : Date.now(),
        msPerPx: msPerPx(),
      };
    };
    const loc = (e) => {
      const rect = cv.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    cv.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      downPos[e.pointerId] = loc(e);
      pts[e.pointerId] = loc(e);
      const ids = keys();
      if (ids.length === 1) startPan(ids[0]);
      else {
        const midX = (pts[ids[0]].x + pts[ids[1]].x) / 2;
        const t0a = chartPin ? chartT0 : Date.now() - chartRangeMin * 60000;
        const t1a = chartPin ? chartT0 + viewSpan() : Date.now();
        gesture = {
          kind: "pinch",
          d0: dist(),
          centerT: t0a + (midX / Math.max(1, plotW())) * (t1a - t0a),
          ms: Math.max(CHART_VIEW_MIN_MS, t1a - t0a),
        };
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (!pts[e.pointerId]) return;
      pts[e.pointerId] = loc(e);
      if (!gesture) return;
      if (gesture.kind === "pan" && keys().length === 1) {
        const dx = pts[gesture.id].x - gesture.startX;
        const dt = dx * gesture.msPerPx;
        if (Math.abs(dx) > 6) applyView(gesture.startT0 - dt, gesture.startT1 - dt);
      } else if (gesture.kind === "pinch" && keys().length === 2) {
        const k = dist() / gesture.d0;
        if (!isFinite(k) || k <= 0) return;
        let ms = Math.min(Math.max(gesture.ms / k, CHART_VIEW_MIN_MS), CHART_VIEW_MAX_MS);
        let t0 = gesture.centerT - ms / 2;
        let t1 = gesture.centerT + ms / 2;
        applyView(t0, t1);
        // Skala pinch jest liczona od ustalonej wartości początkowej (gesture.ms),
        // a nie od bieżącego widoku — inaczej kolejne klatki gubiłyby proporcję.
      }
    });
    const up = (e) => {
      // pointerleave przy przechwyconym wskaźniku nie kończy gestu — inaczej
      // wystarczy drobny ruch palca poza canvas i przesuwanie zostaje przerwane.
      if (e.type === "pointerleave" && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) return;
      if (!pts[e.pointerId]) return;
      const upPos = loc(e);
      const wasDown = downPos[e.pointerId];
      delete downPos[e.pointerId];
      delete pts[e.pointerId];
      const ids = keys();
      if (ids.length === 0) gesture = null;
      else if (gesture && gesture.kind === "pinch" && ids.length === 1) startPan(ids[0]);
      if (wasDown && !gesture && Math.hypot(upPos.x - wasDown.x, upPos.y - wasDown.y) < 10) {
        showProbeAt(upPos.x);
      }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", up);
  }

  function renderWarnings(s) {
    const extra = $("hdrStatusExtra");
    if (!extra) return;
    const chips = [];
    if (s && s.emergencyPending) chips.push({ cls: "warn", text: "AWARYJNE SMAROWANIE" });
    if (s && s.emergencyMode) chips.push({ cls: "warn", text: "AWARYJNY" });
    const cap = config && Number.isFinite(config.tankCapacityMl) ? config.tankCapacityMl : 0;
    if (s && Number.isFinite(s.poz) && cap > 0 && s.poz <= cap * 0.15) chips.push({ cls: "danger", text: "NISKI OLEJ" });
    extra.replaceChildren(...chips.map((chip) => {
      const el = document.createElement("span");
      el.className = "warn-chip warn-chip--" + chip.cls;
      el.textContent = chip.text;
      return el;
    }));
  }

  function alertsCheck(s) {
    if (!s || !connected) {
      alertLatches.oil = false;
      alertLatches.temp = false;
      alertLatches.chain = false;
      return;
    }
    const oilLow = Number.isFinite(s.poz) && s.poz < oilAlertMl;
    const tempHigh = Number.isFinite(s.obdCoolant) && s.obdCoolant >= 105;
    if (oilLow && !alertLatches.oil && alerts.oil) {
      alertLatches.oil = true;
      nativeNotifyAlert("Olejarka — NISKI OLEJ", "Poziom oleju " + Math.round(s.poz) + " ml (próg " + oilAlertMl + " ml). Uzupełnij smarowanie.");
    } else if (!oilLow) {
      alertLatches.oil = false;
    }
    if (tempHigh && !alertLatches.temp && alerts.temp) {
      alertLatches.temp = true;
      nativeNotifyAlert("Olejarka — wysoka temperatura", "CHT silnika: " + Math.round(s.obdCoolant) + " °C. Zwolnij.");
    } else if (!tempHigh) {
      alertLatches.temp = false;
    }
    // Serwis łańcucha: po przekroczeniu interwału przypomnij raz na wyjazd.
    const chainOver = Number.isFinite(chainLastKm) && Number.isFinite(s.distance) && s.distance - chainLastKm >= chainIntKm;
    if (chainOver && !alertLatches.chain) {
      if (s.speed >= 5) {
        alertLatches.chain = true;
        nativeNotifyAlert("Olejarka — SERWIS ŁAŃCUCHA", "Przejechane " + Math.round(s.distance - chainLastKm) + " km (interwał " + chainIntKm + " km). Wyczyść i nasmaruj łańcuch.");
      }
    } else if (!chainOver) {
      alertLatches.chain = false;
    }
  }

  // ---------- Pulpit: kafelki ze statystykami ----------
  function pulpitLoad() {
    try {
      const st = JSON.parse(localStorage.getItem("olejarPulpitStats") || "null");
      if (st && typeof st === "object") {
        pulpitStats = { km: Number(st.km) || 0, fuelL: Number(st.fuelL) || 0, oilMl: Number(st.oilMl) || 0 };
      }
    } catch (e) { /* ignore */ }
    try {
      const c = parseInt(localStorage.getItem("olejarChainIntKm") || "400", 10);
      if (isFinite(c)) chainIntKm = Math.max(100, Math.min(2000, c));
    } catch (e) { /* ignore */ }
    try {
      const c = parseFloat(localStorage.getItem("olejarChainLastKm") || "");
      if (isFinite(c)) chainLastKm = c;
    } catch (e) { /* ignore */ }
  }

  function pulpitPersist() {
    try {
      localStorage.setItem("olejarPulpitStats", JSON.stringify({ km: Math.round(pulpitStats.km), fuelL: pulpitStats.fuelL, oilMl: pulpitStats.oilMl }));
      localStorage.setItem("olejarChainIntKm", String(chainIntKm));
      localStorage.setItem("olejarChainLastKm", Number.isFinite(chainLastKm) ? String(chainLastKm) : "");
    } catch (e) { /* ignore */ }
  }

  function pulpitPersistThrottled() {
    const now = Date.now();
    if (now - pulpitSaveAt < 5000) return;
    pulpitSaveAt = now;
    pulpitPersist();
  }

  // Dociąga delty liczników (przebieg, paliwo, olej) do statystyk długoterminowych.
  // Reset licznika (ujemna delta) nie kasuje statystyk — tylko re-bazuje.
  function pulpitAccum(s) {
    let changed = false;
    if (Number.isFinite(s.distance)) {
      if (Number.isFinite(pBase.odo)) {
        const d = s.distance - pBase.odo;
        if (d >= 0 && d < 5000) { pulpitStats.km += d; changed = true; }
      }
      pBase.odo = s.distance;
    }
    if (Number.isFinite(s.fuelTotal)) {
      if (Number.isFinite(pBase.fuel)) {
        const d = s.fuelTotal - pBase.fuel;
        if (d >= 0 && d < 200) { pulpitStats.fuelL += d; changed = true; }
      }
      pBase.fuel = s.fuelTotal;
    }
    if (Number.isFinite(s.zt)) {
      if (Number.isFinite(pBase.oil)) {
        const d = s.zt - pBase.oil;
        if (d >= 0 && d < 500) { pulpitStats.oilMl += d; changed = true; }
      }
      pBase.oil = s.zt;
    }
    if (changed) pulpitPersistThrottled();
  }

  // Suma zużycia oleju z ostatnich 7 dni (maksimum dzienne z historii wykresu OLEJ DZIŚ).
  function pulpitWeekOil() {
    const arr = chartHist.usageToday;
    if (!arr || !arr.length) return null;
    const days = new Map();
    const nowE = Date.now();
    for (const b of arr) {
      if (!b || !Number.isFinite(b.t) || !Number.isFinite(b.last)) continue;
      const d = Math.floor(b.t / 86400000);
      const cur = days.get(d);
      if (cur === undefined || b.last > cur) days.set(d, b.last);
    }
    const todayIdx = Math.floor(nowE / 86400000);
    let sum = 0;
    for (const [d, v] of days) {
      if (todayIdx - d >= 0 && todayIdx - d <= 6) sum += v;
    }
    return sum > 0 ? sum : null;
  }

  // Maksimum serii z dzisiejszych buforów historii (dla przechyłu: max |wartość|).
  function pulpitTodayMax(key) {
    const arr = chartHist[key];
    if (!arr || !arr.length) return null;
    const nowE = Date.now();
    const today0 = Math.floor(nowE / 86400000) * 86400000;
    let m = -Infinity;
    for (const b of arr) {
      if (!b || !Number.isFinite(b.t)) continue;
      if (b.t < today0) continue;
      if (b.t > nowE) break;
      const v = key === "tilt"
        ? Math.max(Math.abs(b.max != null ? b.max : b.last), Math.abs(b.min != null ? b.min : b.last), Math.abs(b.last))
        : Math.max(b.max != null ? b.max : b.last, b.last);
      if (v > m) m = v;
    }
    return isFinite(m) ? m : null;
  }

  function updatePulpit(s) {
    const sv = s || state || {};
    pulpitAccum(sv);
    const obdKm = Number.isFinite(sv.distance) ? sv.distance : NaN;
    const cfg = config || {};
    // Serwis łańcucha.
    const since = Number.isFinite(chainLastKm) && Number.isFinite(obdKm) ? obdKm - chainLastKm : NaN;
    const next = Number.isFinite(since) ? chainIntKm - since : NaN;
    const elSince = $("chainSinceKm");
    if (elSince) elSince.textContent = Number.isFinite(since) ? Math.round(since).toLocaleString("pl-PL") + " km" : "—";
    const elNext = $("chainNextKm");
    if (elNext) {
      if (!Number.isFinite(next)) elNext.textContent = "—";
      else if (next <= 0) { elNext.textContent = "TERAZ!"; elNext.style.color = "var(--danger)"; }
      else { elNext.textContent = Math.round(next).toLocaleString("pl-PL") + " km"; elNext.style.color = ""; }
    }
    const chainTile = $("chainTile");
    if (chainTile) chainTile.classList.toggle("chain-over", Number.isFinite(next) && next <= 0);
    // Olej: prognoza do dolewu.
    const ml100 = pulpitStats.km > 10 ? (pulpitStats.oilMl / pulpitStats.km) * 100 : null;
    const kmLeft = Number.isFinite(sv.poz) && ml100 != null && ml100 > 0 ? ((sv.poz - oilAlertMl) / ml100) * 100 : null;
    const elKm = $("oilKmLeft");
    if (elKm) elKm.textContent = kmLeft == null ? "—" : (kmLeft > 0 ? "ok. " + Math.round(kmLeft).toLocaleString("pl-PL") + " km" : "DOLEJ OLEJ");
    const capMl = Number.isFinite(cfg.tankCapacityMl) && cfg.tankCapacityMl > 0 ? cfg.tankCapacityMl : null;
    const elKmSub = $("oilKmSub");
    if (elKmSub) elKmSub.textContent = (Number.isFinite(sv.poz)
      ? "poziom " + Math.round(sv.poz) + (capMl ? " / " + Math.round(capMl) + " ml (" + Math.round(sv.poz / capMl * 100) + "%)" : " ml")
      : "poziom —") + (ml100 != null ? " · śr. " + fmt(ml100, 1) + " ml/100 km" : "");
    // Zużycie oleju.
    const elUsage = $("oilUsageToday");
    if (elUsage) elUsage.textContent = (Number.isFinite(sv.zd) ? fmt(sv.zd, 1) : "—") + " ml · " + (Number.isFinite(sv.dd) ? Math.round(sv.dd) : "—") + " dawki";
    const week = pulpitWeekOil();
    const elWeek = $("oilUsageWeek");
    if (elWeek) elWeek.textContent = week === null ? "brak danych" : Math.round(week).toLocaleString("pl-PL") + " ml";
    // Spalanie długoterminowe — nie resetuje się przy tankowaniu.
    const avgL100 = pulpitStats.km > 10 && pulpitStats.fuelL > 0 ? (pulpitStats.fuelL / pulpitStats.km) * 100 : null;
    const elAvg = $("fuelAvgL100");
    if (elAvg) elAvg.textContent = avgL100 === null ? "—" : fmt(avgL100, 1) + " l/100";
    const elFuelNow = $("fuelNow");
    if (elFuelNow) elFuelNow.textContent = (connected && Number.isFinite(sv.obdFuel)) ? fmt(sv.obdFuel, 1) + " L/h" : "—";
    // Przebieg.
    const elOdo = $("odoKm");
    if (elOdo) elOdo.textContent = Number.isFinite(obdKm) ? Math.round(obdKm).toLocaleString("pl-PL") + " km" : "—";
    const elTrip = $("odoTrip");
    if (elTrip) elTrip.textContent = Number.isFinite(sv.trip) ? fmt(sv.trip, 1) + " km" : "—";
    // Maksima dnia z historii.
    const mSpeed = pulpitTodayMax("speed");
    const mRpm = pulpitTodayMax("rpm");
    const mCoolant = pulpitTodayMax("coolant");
    const mTilt = pulpitTodayMax("tilt");
    const elMS = $("maxSpeedVal");
    if (elMS) elMS.textContent = mSpeed === null ? "—" : Math.round(mSpeed).toLocaleString("pl-PL") + " km/h";
    const elMR = $("maxRpmVal");
    if (elMR) elMR.textContent = mRpm === null ? "—" : Math.round(mRpm).toLocaleString("pl-PL") + " obr";
    const elMC = $("maxCoolantVal");
    if (elMC) elMC.textContent = mCoolant === null ? "—" : fmt(mCoolant, 1) + " °C";
    const elMT = $("maxTiltVal");
    if (elMT) elMT.textContent = mTilt === null ? "—" : fmt(mTilt, 1) + "°";
    // Podgląd ustawień smarowania (bez wchodzenia w Ustawienia).
    const doseKm = Number.isFinite(cfg.intervalImp) && Number.isFinite(cfg.wheelCircumCm) && cfg.wheelCircumCm > 0 ? (cfg.intervalImp * cfg.wheelCircumCm) / 100000 : null;
    const elDose = $("doseEveryKm");
    if (elDose) elDose.textContent = doseKm === null ? "—" : doseKm.toFixed(2).replace(".", ",") + " km";
    const elMinV = $("minSpeedValue");
    if (elMinV) elMinV.textContent = Number.isFinite(cfg.minSpeedKph) ? Math.round(cfg.minSpeedKph) + " km/h" : "—";
    const elLim = $("dailyLimitValue");
    if (elLim) elLim.textContent = Number.isFinite(cfg.dailyLimitImp) ? (cfg.dailyLimitImp > 0 ? cfg.dailyLimitImp + "/dzień" : "brak") : "—";
    const elFlow = $("pumpFlowValue");
    if (elFlow) elFlow.textContent = Number.isFinite(cfg.pumpFlowMlPer1k) ? fmt(cfg.pumpFlowMlPer1k, 1) + " ml/1k" : "—";
    // Stan połączenia.
    const sta = [];
    if (connected) sta.push("BT ✓" + (btRssi != null ? " " + btRssi + " dBm" : ""));
    else sta.push("BT ✗");
    if (sv.auto) sta.push("AUTO");
    if (sv.rain) sta.push("DESZCZ");
    if (sv.emergency) sta.push("AWARYJNY");
    const elConn = $("connStatus");
    if (elConn) elConn.textContent = sta.length ? sta.join(" · ") : "—";
    refuelPulpit(sv);
    crashPulpit();
  }

  function crashPulpit() {
    const st = $("crashTileState");
    if (st) st.textContent = crashCfg.on ? (crashState.latched ? "ALARM!" : "uzbrojony") : "wyłączony";
    const nums = $("crashTileNums");
    if (nums) nums.textContent = crashCfg.nums.length
      ? crashCfg.nums.length + " / 3 (" + crashCfg.delay + " s)" + (crashCfg.call && crashCfg.nums[crashCfg.callIdx] ? " · dzwoni: " + (crashCfg.nums[crashCfg.callIdx].label || crashCfg.nums[crashCfg.callIdx].num) : "")
      : "brak — dodaj w Ustawieniach";
  }

  // ---------- Tankowania i auto-kalibracja FCAL ----------
  function cfgField(name) {
    return config && config[name] !== undefined && config[name] !== null ? config[name] : NaN;
  }

  function refuelLoad() {
    try {
      const r = JSON.parse(localStorage.getItem(REFUEL_KEY) || "null");
      if (Array.isArray(r)) refuels = r.slice(-120);
    } catch (e) { /* ignore */ }
    try {
      const f = JSON.parse(localStorage.getItem(REFUEL_FCAL_KEY) || "null");
      if (f && typeof f === "object") fcalAuto = Object.assign({ factor: null }, f);
    } catch (e) { /* ignore */ }
    lastRefuel = refuels.length ? refuels[refuels.length - 1] : null;
  }

  function refuelSave() {
    try { localStorage.setItem(REFUEL_KEY, JSON.stringify(refuels)); } catch (e) { /* ignore */ }
    try { localStorage.setItem(REFUEL_FCAL_KEY, JSON.stringify(fcalAuto)); } catch (e) { /* ignore */ }
  }

  // Zużycie paliwa [L] i dystans [km] od wskazanego punktu (fuel_total i distance rosną monotonicznie).
  function refuelDelta(s, from) {
    if (!s || !from) return null;
    if (!Number.isFinite(s.fuelTotal) || !Number.isFinite(s.distance)) return null;
    if (!Number.isFinite(from.fuelTotal) || !Number.isFinite(from.dist)) return null;
    const dFuel = s.fuelTotal - from.fuelTotal;
    const dDist = s.distance - from.dist;
    if (dFuel < 0 || dDist < 0) return null;
    return { fuel: dFuel, dist: dDist };
  }

  // Ostatni wpis, który NIE jest dotankowaniem (czyli tankowanie do pełna) — punkt
  // odniesienia dla l/100 i auto-korekty FCAL.
  function refuelLastFullIdx() {
    for (let i = refuels.length - 1; i >= 0; i--) if (!refuels[i].partial) return i;
    return -1;
  }
  // Suma litrów dotankowań zapisanych PO wpisie o indeksie fromIdx (-1 = wszystkie).
  function refuelPartialSum(fromIdx) {
    let sum = 0;
    for (let i = fromIdx + 1; i < refuels.length; i++) if (refuels[i].partial) sum += refuels[i].liters || 0;
    return Math.round(sum * 100) / 100;
  }

  // partial=true → dotankowanie (bez zerowania baku); false → tankowanie do pełna.
  function refuelCommit(liters, price, skipTankReset, partial) {
    const s = state || {};
    const fuelCap = TANK_LITERS;
    if (!(liters > 0) || liters > fuelCap + 0.5) {
      nativeNotifyAlert("Tankowanie", "Podaj ilość w zakresie 0,1–" + fmt(fuelCap, 0) + " L.");
      return null;
    }
    liters = Math.round(liters * 10) / 10;
    // Do pełna: ustaw wskaźnik paliwa (chyba że zrobił to już reset z HUD).
    // Dotankowanie: dopisz litry do modelu baku w olejarce (FUEL_ADD), nie zeruj do 20 L.
    if (partial) command("FUEL_ADD " + liters);
    else if (!skipTankReset) command("RST_FUEL_LVL");
    const hasObd = Number.isFinite(s.fuelTotal) && Number.isFinite(s.distance);
    // Punkt odniesienia = ostatnie tankowanie DO PEŁNA; dotankowania się do niego sumują.
    const fullIdx = refuelLastFullIdx();
    const base = fullIdx >= 0 ? refuels[fullIdx] : null;
    const priorPartials = refuelPartialSum(fullIdx);
    // Zużycie paliwa [L] i dystans [km] od ostatniego pełnego — do wpisu
    // „od pełnego", rzeczywistego l/100 i auto-korekty FCAL.
    const d = refuelDelta(s, base);
    const entry = {
      t: Date.now(),
      odo: hasObd ? Math.round(s.distance) : null,
      liters: Math.round(liters * 100) / 100,
      price: price > 0 ? Math.round(price * 100) / 100 : null,
      fuelTotal: hasObd ? s.fuelTotal : null,
      dist: hasObd ? s.distance : null,
      l100: null,
      cost: price > 0 ? Math.round(liters * price * 100) / 100 : null,
      fcalFrom: null,
      fcalTo: null,
      dt: null,
      partial: partial ? true : false,
    };
    // Dystans przejechany od ostatniego pełnego (do HA, kafelek „od pełnego").
    entry.since = d && Number.isFinite(d.dist) && d.dist > 0 ? Math.round(d.dist * 10) / 10 : null;
    // Rzeczywiste spalanie i korekta FCAL tylko dla tankowania do pełna (z OBD):
    // przy dotankowaniu zbiornik nie jest pełny, więc wynik zaniżałby spalanie.
    const filled = liters + priorPartials;
    if (!partial && d && d.dist > 20 && d.fuel > 0.2) {
      const realL100 = filled / d.dist * 100;
      entry.l100 = Math.round(realL100 * 100) / 100;
      // Model OBD przewidział d.fuel L na dystansie d.dist. Skoryguj FCAL proporcjonalnie.
      const fcalNow = Number(cfgField("fuelCal"));
      if (Number.isFinite(fcalNow) && fcalNow > 0) {
        const err = filled / d.fuel;              // >1 = model zaniża zużycie
        const errPct = (err - 1) * 100;
        if (Math.abs(errPct) > 3) {
          entry.dt = Math.round(errPct * 10) / 10;
          entry.fcalFrom = Math.round(fcalNow);
          const rawNew = fcalNow * err;
          // Uśrednianie: nie skaczemy po jednym tankowaniu, idziemy 60% w stronę nowej wartości.
          const target = fcalNow + (rawNew - fcalNow) * 0.6;
          const newCal = Math.max(50, Math.min(200, Math.round(target)));
          if (newCal !== Math.round(fcalNow)) {
            entry.fcalTo = newCal;
            command("SET FCAL " + newCal);
            fcalAuto = { factor: newCal, from: Math.round(fcalNow), at: Date.now(), entryT: entry.t };
            nativeNotifyAlert("Olejarka — kalibracja paliwa",
              "Model zaniżał o " + fmt(Math.abs(errPct), 1) + "%. FCAL " + Math.round(fcalNow) + " → " + newCal +
              " (do cofnięcia w historii tankowań).");
          }
        }
      }
    }
    refuels.push(entry);
    if (refuels.length > 120) refuels.shift();
    // lastRefuel = ostatnie tankowanie DO PEŁNA (dotankowania nie zmieniają bazy l/100).
    lastRefuel = refuels[refuelLastFullIdx()] || null;
    refuelSave();
    haRefuelSend(entry);
    renderRefuelList();
    updatePulpit(state);
    return entry;
  }

  // Cofnięcie ostatniej auto-korekty FCAL.
  function refuelUndoFcal() {
    if (!fcalAuto || !Number.isFinite(fcalAuto.from)) {
      nativeNotifyAlert("Tankowania", "Nie ma zapisanej auto-korekty FCAL do cofnięcia.");
      return;
    }
    command("SET FCAL " + fcalAuto.from);
    fcalManualHold = true;
    nativeNotifyAlert("Tankowania", "Przywrócono FCAL " + fcalAuto.from + ". Auto-kalibracja wstrzymana do następnego tankowania.");
    fcalAuto = { factor: null };
    refuelSave();
    updatePulpit(state);
  }
  // Wysyłka zdarzenia tankowania do HA (przez kolejkę offline, jeśli trzeba).
  function haRefuelSend(entry) {
    if (!haCfg.on) return;
    const url = haWebhookUrl();
    const payload = { data: new Date(entry.t).toISOString() };
    if (Number.isFinite(entry.odo)) payload.odo = entry.odo;
    if (Number.isFinite(entry.liters)) payload.liters = entry.liters;
    if (entry.price) payload.price = entry.price;
    if (entry.l100 != null) payload.l100 = entry.l100;
    if (entry.cost) payload.cost = entry.cost;
    if (entry.since != null) payload.since = entry.since;
    if (entry.partial) payload.partial = true;
    // Koszt paliwa z ostatnich 30 dni (suma wpisów historii), jak w Pulpicie.
    const month = refuels.filter((r) => r.cost && Date.now() - r.t < 31 * 86400000);
    const sum30 = month.reduce((a, r) => a + (r.cost || 0), 0);
    if (sum30 > 0) payload.cost30 = Math.round(sum30 * 100) / 100;
    if (haPos && haPos.coords) {
      payload.lat = Math.round(haPos.coords.latitude * 1e6) / 1e6;
      payload.lon = Math.round(haPos.coords.longitude * 1e6) / 1e6;
    }
    if (!/^https?:\/\//i.test(url)) { haQueueAdd(payload, REFUEL_HOOK); return; }
    fetch(url + "/api/webhook/" + encodeURIComponent(REFUEL_HOOK), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => { if (!r.ok) haQueueAdd(payload, REFUEL_HOOK); })
      .catch(() => haQueueAdd(payload, REFUEL_HOOK));
  }

  // Kafelek + historia w Pulpicie.
  function refuelPulpit(sv) {
    // „ostatnie" = najnowszy wpis (także dotankowanie); baza l/100 = ostatnie DO PEŁNA.
    const lastAny = refuels.length ? refuels[refuels.length - 1] : null;
    const full = lastRefuel;
    const dist = full && Number.isFinite(sv.distance) && Number.isFinite(full.dist)
      ? sv.distance - full.dist : NaN;
    const used = full && Number.isFinite(sv.fuelTotal) && Number.isFinite(full.fuelTotal)
      ? sv.fuelTotal - full.fuelTotal : NaN;
    const elLast = $("refuelLast");
    if (elLast) {
      elLast.textContent = lastAny
        ? new Date(lastAny.t).toLocaleDateString("pl-PL") + " · " + fmt(lastAny.liters, 2) + " L" +
          (lastAny.partial ? " (dotank.)" : "") + " · " +
          (lastAny.l100 != null ? fmt(lastAny.l100, 2) + " l/100" : "l/100 —")
        : "brak wpisów";
    }
    const elSince = $("refuelSince");
    if (elSince) {
      const sumP = full ? refuelPartialSum(refuelLastFullIdx()) : 0;
      elSince.textContent = full
        ? "od pełnego: " + (Number.isFinite(dist) ? Math.round(dist) + " km" : "—") +
          (Number.isFinite(used) && used >= 0 ? " · " + fmt(used, 2) + " L" : "") +
          (sumP > 0 ? " (+" + fmt(sumP, 2) + " L dotank.)" : "")
        : (refuels.length ? "brak tankowania do pełna" : "—");
    }
    const elFcal = $("refuelFcal");
    if (elFcal) {
      elFcal.hidden = !(fcalAuto && Number.isFinite(fcalAuto.from));
      elFcal.onclick = () => refuelUndoFcal();
    }
    const elCost = $("refuelCost");
    if (elCost) {
      const month = refuels.filter((r) => r.cost && Date.now() - r.t < 31 * 86400000);
      const sum = month.reduce((a, r) => a + (r.cost || 0), 0);
      elCost.textContent = sum > 0 ? fmt(sum, 2) + " zł (30 dni)" : "—";
    }
  }

  // Pełna lista tankowań (okno historii).
  function renderRefuelList() {
    const box = $("refuelList");
    if (!box) return;
    if (!refuels.length) {
      box.innerHTML = '<p class="setting-hint">Brak tankowań. Kliknij kafelek „Tankowanie" w Pulpicie.</p>';
      return;
    }
    const rows = refuels.slice().reverse().map((r) => {
      const dt = new Date(r.t);
      const when = dt.toLocaleDateString("pl-PL") + " " + dt.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
      const bits = [
        fmt(r.liters, 2) + " L" + (r.partial ? " (dotank.)" : ""),
        Number.isFinite(r.odo) ? r.odo.toLocaleString("pl-PL") + " km" : "",
        r.l100 != null ? fmt(r.l100, 2) + " l/100" : "",
        r.cost ? fmt(r.cost, 2) + " zł" : "",
        r.fcalTo ? "FCAL " + r.fcalFrom + "→" + r.fcalTo + " (" + (r.dt > 0 ? "+" : "") + fmt(r.dt, 1) + "%)" : "",
      ].filter(Boolean);
      return '<div class="refuel-row"><span>' + when + "</span><small>" + bits.join(" · ") + "</small>" +
        '<div class="refuel-row-actions">' +
        '<button type="button" class="refuel-mini" data-refuel-edit="' + r.t + '">✎ Popraw</button>' +
        '<button type="button" class="refuel-mini danger" data-refuel-del="' + r.t + '">🗑 Usuń</button>' +
        "</div></div>";
    }).join("");
    box.innerHTML = rows;
    box.querySelectorAll("[data-refuel-edit]").forEach((btn) => {
      btn.onclick = () => refuelEditEntry(Number(btn.dataset.refuelEdit));
    });
    box.querySelectorAll("[data-refuel-del]").forEach((btn) => {
      btn.onclick = () => refuelDeleteEntry(Number(btn.dataset.refuelDel));
    });
  }

  // Przelicza l/100 i status korekty FCAL dla wszystkich wpisów po edycji/usunięciu
  // (łańcuch: dystans i zużycie liczone od ostatniego tankowania DO PEŁNA; dotankowania
  // sumują się do następnego pełnego i same nie mają l/100).
  function refuelRecompute() {
    refuels.sort((a, b) => a.t - b.t);
    let base = null;        // ostatnie tankowanie do pełna (fuelTotal/dist)
    let accLiters = 0;      // suma litrów dotankowań od tego pełnego
    for (let i = 0; i < refuels.length; i++) {
      const r = refuels[i];
      if (r.partial) {
        r.l100 = null;
        r.dt = null;
        r.fcalFrom = null;
        r.fcalTo = null;
        accLiters += Number.isFinite(r.liters) ? r.liters : 0;
        continue;
      }
      const dFuel = base ? r.fuelTotal - base.fuelTotal : NaN;
      const dDist = base ? r.dist - base.dist : NaN;
      if (!base || !Number.isFinite(dFuel) || !Number.isFinite(dDist) || dFuel < 0 || dDist <= 20 || dFuel <= 0.2) {
        r.l100 = null;
        r.dt = null;
        r.fcalFrom = null;
        r.fcalTo = null;
      } else {
        const filled = r.liters + accLiters;
        r.l100 = Math.round((filled / dDist * 100) * 100) / 100;
        r.dt = Math.round(((filled / dFuel) - 1) * 1000) / 10;
        if (!(r.fcalTo != null && r.fcalFrom != null)) {
          // Korekta nie była wykonana — nie pokazuj niepotwierdzonej zmiany FCAL.
          r.fcalFrom = null;
          r.fcalTo = null;
        }
      }
      base = { fuelTotal: r.fuelTotal, dist: r.dist };
      accLiters = 0;
    }
    // Baza l/100 = ostatnie tankowanie DO PEŁNA, nie ostatni wpis.
    lastRefuel = null;
    for (let i = refuels.length - 1; i >= 0; i--) if (!refuels[i].partial) { lastRefuel = refuels[i]; break; }
    refuelSave();
  }

  function refuelEditEntry(t) {
    const i = refuels.findIndex((r) => r.t === t);
    if (i < 0) return;
    const r = refuels[i];
    askInput("Popraw ilość paliwa (litry)", fmt(r.liters, 2), null, fmtInput(r.liters),
      { title: "Tankowanie", kicker: "TANKOWANIE", ok: "DALEJ" }).then((v) => {
      if (v == null) return;
      const liters = parseFloat(String(v).replace(",", "."));
      if (!isFinite(liters) || liters <= 0 || liters > TANK_LITERS + 0.5) {
        nativeNotifyAlert("Tankowania", "Nie rozpoznano ilości (0,1–" + fmt(TANK_LITERS, 0) + " L).");
        return;
      }
      askInput("Cena za litr", r.price ? fmtInput(r.price) : "", null, r.price ? fmtInput(r.price) : "",
        { title: "Tankowanie", kicker: "TANKOWANIE", ok: "ZAPISZ", skip: "POMIŃ" }).then((p) => {
        if (p == null) return;
        const noPrice = p === REFUEL_SKIP || String(p).trim() === "";
        const price = noPrice ? NaN : parseFloat(String(p).replace(",", "."));
        r.liters = Math.round(liters * 100) / 100;
        r.price = Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null;
        r.cost = r.price ? Math.round(r.liters * r.price * 100) / 100 : null;
        refuelRecompute();
        renderRefuelList();
        updatePulpit(state);
        nativeNotifyAlert("Tankowania", "Poprawiono wpis: " + fmt(r.liters, 2) + " L" + (r.l100 != null ? " · " + fmt(r.l100, 2) + " l/100" : ""), true);
      });
    });
  }

  function refuelDeleteEntry(t) {
    const i = refuels.findIndex((r) => r.t === t);
    if (i < 0) return;
    const r = refuels[i];
    askConfirm("Usunąć tankowanie " + fmt(r.liters, 2) + " L z " + new Date(r.t).toLocaleString("pl-PL") + "?", true, "TAK, USUŃ", "Tankowania", "NIE").then((yes) => {
      if (!yes) return;
      const undo = r.fcalTo != null && r.fcalFrom != null;
      refuels.splice(i, 1);
      refuelRecompute();
      const finish = () => {
        renderRefuelList();
        updatePulpit(state);
        nativeNotifyAlert("Tankowania", "Usunięto wpis." + (undo ? " FCAL przywrócony do " + r.fcalFrom + "." : ""), true);
      };
      if (undo) {
        askConfirm("Ten wpis korygował FCAL (" + r.fcalFrom + " → " + r.fcalTo + ").\nPrzywrócić FCAL " + r.fcalFrom + "?", false, "PRZYWRÓĆ", "Tankowania", "NIE").then((yes2) => {
          if (yes2) {
            command("SET FCAL " + r.fcalFrom);
            fcalAuto = { factor: null };
            fcalManualHold = true;
          }
          finish();
        });
      } else {
        finish();
      }
    });
  }

  function refuelOpen() {
    askInput("Ile litrów wlano? (do blaszki)", "np. 14,2", null, null,
      { title: "Tankowanie", kicker: "TANKOWANIE", ok: "DALEJ" }).then((v) => {
      if (v == null) return;
      const liters = parseFloat(String(v).replace(",", "."));
      if (!isFinite(liters) || liters <= 0) {
        nativeNotifyAlert("Tankowanie", "Nie rozpoznano ilości. Wpisz liczbę, np. 14,2");
        return;
      }
      refuelAskPrice((price) => {
        const e = refuelCommit(liters, Number.isFinite(price) && price > 0 ? price : NaN);
        if (e) {
          nativeNotifyAlert("Zatankowano", fmt(e.liters, 2) + " L" + (e.l100 != null ? " · " + fmt(e.l100, 2) + " l/100" : "") +
            (e.fcalTo ? " · FCAL → " + e.fcalTo : ""), true);
        }
      });
    });
  }

  // Dotankowanie (nie do pełna): dopisuje litry do wskaźnika (FUEL_ADD) bez resetu
  // do 20 L. Nie wylicza l/100 (zbiornik nie jest pełny) i nie rusza bazy l/100.
  function refuelTopUp() {
    askInput("Ile litrów dolano?", "np. 5,0", null, null,
      { title: "Dotankowanie", kicker: "TANKOWANIE", ok: "DALEJ" }).then((v) => {
      if (v == null) return;
      const liters = parseFloat(String(v).replace(",", "."));
      if (!isFinite(liters) || liters <= 0 || liters > TANK_LITERS + 0.5) {
        nativeNotifyAlert("Dotankowanie", "Nie rozpoznano ilości (0,1–" + fmt(TANK_LITERS, 0) + " L).");
        return;
      }
      refuelAskPrice((price) => {
        const e = refuelCommit(liters, Number.isFinite(price) && price > 0 ? price : NaN, true, true);
        if (e) {
          nativeNotifyAlert("Dotankowano", fmt(e.liters, 2) + " L · wskaźnik +" + fmt(e.liters, 1) + " L", true);
        }
      });
    });
  }

  // Wspólne pytanie o cenę za litr: „POMIŃ" = zapisz bez ceny, „ZAPISZ" = z ceną,
  // „ANULUJ" = przerwij całe tankowanie (done nie jest wołane).
  function refuelAskPrice(done) {
    const ph = lastRefuel && lastRefuel.price ? fmtInput(lastRefuel.price) : "np. 6,50";
    askInput("Cena za litr", ph, null, "", { title: "Tankowanie", kicker: "TANKOWANIE", ok: "ZAPISZ", skip: "POMIŃ" }).then((p) => {
      if (p == null) return; // ANULUJ
      const noPrice = p === REFUEL_SKIP || String(p).trim() === "";
      done(noPrice ? NaN : parseFloat(String(p).replace(",", ".")));
    });
  }

  function refuelHistoryOpen() {
    renderRefuelList();
    const panel = $("refuelPanel");
    if (panel) panel.hidden = false;
  }

  // Tankowanie z resetu wskaźnika paliwa: przytrzymanie ustawia pełny bak i pyta,
  // czy zapisać tankowanie. Litry = to, ile brakowało do pełnych 20 L.
  function refuelFromTankReset() {
    const before = state && Number.isFinite(state.fuelLevel) ? state.fuelLevel : NaN;
    const calc = Number.isFinite(before) ? Math.round((TANK_LITERS - before) * 10) / 10 : NaN;
    command("RST_FUEL_LVL");
    if (!(calc > 0.1)) {
      nativeNotifyAlert("Tankowania", "Wskaźnik był pełny — nie zapisano tankowania.");
      return;
    }
    // Kalibracja: pole z wstępnie wypełnioną, wyliczoną ilością (20 − stan przed resetem) —
    // użytkownik może ją poprawić, zanim wpis trafi do dziennika.
    askInput("Wskaźnik przed resetem: " + fmt(before, 2) + " L — wyliczono " + fmt(calc, 1) + " L.\nPopraw, jeśli trzeba.",
      "Litry (0,1–" + fmt(TANK_LITERS, 0) + ")", null, fmtInput(calc),
      { title: "Tankowanie", kicker: "TANKOWANIE", ok: "ZAPISZ" }).then((v) => {
      if (v == null) return;
      const liters = parseFloat(String(v).replace(",", "."));
      if (!isFinite(liters) || liters <= 0 || liters > TANK_LITERS + 0.5) {
        nativeNotifyAlert("Tankowanie", "Nie rozpoznano ilości (0,1–" + fmt(TANK_LITERS, 0) + " L).");
        return;
      }
      refuelAskPrice((price) => {
        const e = refuelCommit(liters, Number.isFinite(price) && price > 0 ? price : NaN, true);
        if (e) nativeNotifyAlert("Zatankowano", fmt(e.liters, 1) + " L" + (e.l100 != null ? " · " + fmt(e.l100, 2) + " l/100" : "") + (e.fcalTo ? " · FCAL → " + e.fcalTo : ""), true);
      });
    });
  }

  function refuelHistoryClose() {
    const panel = $("refuelPanel");
    if (panel) panel.hidden = true;
  }

  // ---------- Edycja kafelków HUD ----------
  // Katalog wartości, które można wstawić w kafelek. get(s) zwraca {v, dec} albo null.
  const TILE_CATALOG = [
    { id: "coolant", label: "Temp. silnika", unit: "°C", dec: 0, get: (s) => Number.isFinite(s.obdCoolant) ? s.obdCoolant : null },
    { id: "outside", label: "Temp. zewnętrzna", unit: "°C", dec: 1, get: (s) => Number.isFinite(s.temp) ? s.temp : null },
    { id: "rpm", label: "Obroty silnika", unit: "obr", dec: 0, get: (s) => Number.isFinite(s.rpm) ? s.rpm : null },
    { id: "speed", label: "Prędkość", unit: "km/h", dec: 0, get: (s) => Number.isFinite(s.speed) ? s.speed : null },
    { id: "fuelrate", label: "Spalanie chwilowe", unit: "L/h", dec: 2, get: (s) => (connected && Number.isFinite(s.obdFuel)) ? s.obdFuel : null },
    { id: "fuel100", label: "Spalanie l/100", unit: "l/100", dec: 1, get: (s) => (connected && Number.isFinite(s.obdFuel) && s.speed >= 1) ? s.obdFuel * 100 / s.speed : null },
    { id: "avg", label: "Spalanie średnie", unit: "l/100", dec: 1, get: (s) => (Number.isFinite(s.distance) && s.distance > 0) ? s.fuelTotal * 100 / s.distance : null },
    { id: "load", label: "Obciążenie LOAD", unit: "%", dec: 0, get: (s) => Number.isFinite(s.load) ? s.load : null },
    { id: "throttle", label: "Manetka TPS", unit: "%", dec: 0, get: (s) => Number.isFinite(s.throttle) ? s.throttle : null },
    { id: "progress", label: "Postęp dawki", unit: "%", dec: 0, get: (s) => Number.isFinite(s.pct) ? s.pct : null },
    { id: "oil", label: "Poziom oleju", unit: "ml", dec: 0, get: (s) => Number.isFinite(s.poz) ? s.poz : null },
    { id: "imp", label: "Licznik impulsów", unit: "imp", dec: 0, get: (s) => Number.isFinite(s.imp) ? s.imp : null },
    { id: "dosesday", label: "Dawki dziś", unit: "szt", dec: 0, get: (s) => Number.isFinite(s.dd) ? s.dd : null },
    { id: "dosestotal", label: "Dawki łącznie", unit: "szt", dec: 0, get: (s) => Number.isFinite(s.dt) ? s.dt : null },
    { id: "usageToday", label: "Zużycie dziś", unit: "ml", dec: 1, get: (s) => Number.isFinite(s.zd) ? s.zd : null },
    { id: "usageTotal", label: "Zużycie łącznie", unit: "ml", dec: 1, get: (s) => Number.isFinite(s.zt) ? s.zt : null },
    { id: "trip", label: "TRIP", unit: "km", dec: 1, get: (s) => Number.isFinite(s.trip) ? s.trip : null },
    { id: "ododist", label: "Dystans OBD", unit: "km", dec: 1, get: (s) => Number.isFinite(s.distance) ? s.distance : null },
    { id: "range", label: "Zasięg (paliwo)", unit: "km", dec: 0, get: (s) => {
        const remain = Number.isFinite(s.fuelLevel) ? s.fuelLevel : (Number.isFinite(s.fuelTotal) ? TANK_LITERS - s.fuelTotal : null);
        if (!Number.isFinite(remain) || !Number.isFinite(s.fuelTotal) || s.fuelTotal <= 0 || !Number.isFinite(s.distance)) return null;
        return Math.floor(remain * s.distance / s.fuelTotal);
      } },
    { id: "fuellevel", label: "Poziom paliwa", unit: "L", dec: 1, get: (s) => Number.isFinite(s.fuelLevel) ? s.fuelLevel : null },
    { id: "fueltotal", label: "Paliwo zużyte łącznie", unit: "L", dec: 2, get: (s) => Number.isFinite(s.fuelTotal) ? s.fuelTotal : null },
    { id: "oiltank", label: "Olej — % zbiornika", unit: "%", dec: 0, get: (s) => (Number.isFinite(s.poz) && Number.isFinite(config && config.tankCapacityMl) && config.tankCapacityMl > 0) ? s.poz / config.tankCapacityMl * 100 : null },
    { id: "tilt", label: "Przechył", unit: "°", dec: 0, get: () => Number.isFinite(hudTiltSmooth) ? hudTiltSmooth : null },
    { id: "coolantoil", label: "Temp. oleju (zewn.)", unit: "°C", dec: 1, get: (s) => Number.isFinite(s.temp) ? s.temp : null },
  ];

  // Domyślne ustawienie kafelków = to, co jest w HTML fabrycznie.
  const TILE_DEFAULTS = {
    coolant: { label: "ENGINE", src: "coolant" },
    outside: { label: "OUTSIDE", src: "outside" },
    fuelrate: { label: "FUEL RATE", src: "fuelrate" },
    avg: { label: "AVG", src: "avg" },
    trip: { label: "TRIP", src: "trip" },
    range: { label: "ZASIĘG", src: "range" },
    oil: { label: "OLEJ", src: "oil" },
    imp: { label: "LICZNIK", src: "imp" },
    dosesday: { label: "DZIŚ", src: "dosesday" },
    dosestotal: { label: "ŁĄCZNIE", src: "dosestotal" },
  };

  const TILES_KEY = "olejarHudTiles";
  // Te kafelki są na stałe — edycja zablokowana (TRIP i ZASIĘG nie są potrzebne do podmiany).
  const TILE_LOCKED = ["trip", "range"];
  let tileCfg = {};          // { tileId: {label, src} }
  let hudEditMode = false;

  function tileCatalogEntry(src) {
    return TILE_CATALOG.find((c) => c.id === src) || null;
  }

  function tileLoad() {
    tileCfg = {};
    try {
      const raw = JSON.parse(localStorage.getItem(TILES_KEY) || "null");
      if (raw && typeof raw === "object") {
        for (const k in TILE_DEFAULTS) {
          const d = TILE_DEFAULTS[k];
          const r = raw[k];
          if (r && typeof r === "object" && tileCatalogEntry(r.src)) {
            tileCfg[k] = { label: String(r.label || d.label).slice(0, 14), src: r.src };
          } else {
            tileCfg[k] = { label: d.label, src: d.src };
          }
        }
      } else {
        for (const k in TILE_DEFAULTS) tileCfg[k] = Object.assign({}, TILE_DEFAULTS[k]);
      }
    } catch (e) {
      for (const k in TILE_DEFAULTS) tileCfg[k] = Object.assign({}, TILE_DEFAULTS[k]);
    }
    tileApplyLabels();
  }

  function tileSave() {
    try { localStorage.setItem(TILES_KEY, JSON.stringify(tileCfg)); } catch (e) { /* ignore */ }
  }

  function tileResetAll() {
    askConfirm("Przywrócić domyślne kafelki HUD?", false, "PRZYWRÓĆ", "Kafelki HUD").then((yes) => {
      if (!yes) return;
      try { localStorage.removeItem(TILES_KEY); } catch (e) { /* ignore */ }
      tileLoad();
      tileRender(null);
      nativeNotifyAlert("Kafelki HUD", "Przywrócono domyślne.");
    });
  }

  // Ustawia nazwy kafelków wg konfiguracji (etykiety są w HTML — podmieniamy tekst).
  function tileApplyLabels() {
    document.querySelectorAll("#hud .hud-count[data-tile]").forEach((el) => {
      const id = el.dataset.tile;
      const c = tileCfg[id] || TILE_DEFAULTS[id];
      if (!c) return;
      const lab = el.querySelector("label");
      if (lab) lab.textContent = c.label;
      const unit = el.querySelector("small");
      const src = tileCatalogEntry(c.src);
      if (unit && src && id !== "fuelrate") unit.textContent = src.unit;
    });
  }

  // Wpisuje wartości do kafelków (wołane przy każdym pakiecie stanu).
  function tileRender(s) {
    if (!s) return;
    document.querySelectorAll("#hud .hud-count[data-tile]").forEach((el) => {
      const id = el.dataset.tile;
      const c = tileCfg[id] || TILE_DEFAULTS[id];
      if (!c) return;
      const src = tileCatalogEntry(c.src);
      if (!src) return;
      const val = src.get(s);
      const span = el.querySelector("span");
      if (!span) return;
      span.textContent = val === null || val === undefined ? "—" : fmt(val, src.dec);
      // Jednostka dynamiczna dla spalania chwilowego (l/100 przy jeździe, L/h na postoju).
      if (id === "fuelrate") {
        const unit = el.querySelector("small");
        if (unit) unit.textContent = s.speed >= 1 ? "l/100" : "L/h";
      }
    });
  }

  // --- Tryb edycji HUD ---
  function hudEditStart() {
    hudEditMode = true;
    showHud();
    document.body.classList.add("hud-editing");
    const ok = $("hudEditOkBtn");
    if (ok) ok.hidden = false;
    toggleMenu(false);
    hudEditMarkTiles();
    nativeNotifyAlert("Edycja HUD", "Dotknij kafelek, żeby wybrać jego wartość — nazwa ustawi się automatycznie. Gotowe — przycisk OK u góry.");
  }

  function hudEditStop() {
    hudEditMode = false;
    document.body.classList.remove("hud-editing");
    const ok = $("hudEditOkBtn");
    if (ok) ok.hidden = true;
    tileSave();
    nativeNotifyAlert("Edycja HUD", "Zapisano kafelki.");
  }

  function hudEditMarkTiles() {
    document.querySelectorAll("#hud .hud-count[data-tile]").forEach((el) => {
      if (TILE_LOCKED.indexOf(el.dataset.tile) >= 0) return;   // bez obwódki i ✎
      el.classList.add("hud-tile-editable");
    });
  }

  // Dotknięcie kafelka w trybie edycji -> okno edycji nazwy i wartości.
  function tileEditOpen(tileId) {
    const def = TILE_DEFAULTS[tileId];
    if (!def) return;
    if (TILE_LOCKED.indexOf(tileId) >= 0) {   // TRIP i ZASIĘG bez edycji
      nativeNotifyAlert("Kafelki HUD", "Ten kafelek jest na stałe — edycja zablokowana.");
      return;
    }
    const cur = tileCfg[tileId] || def;
    // Klik w kartę od razu pokazuje listę wartości — nazwa ustawia się automatycznie.
    tilePickSource(tileId, cur.src);
  }

  function tilePickSource(tileId, curSrc) {
    const card = $("confirmCard");
    const dialog = $("confirmDialog");
    $("confirmTitle").textContent = "Kafelek HUD";
    $("confirmMessage").textContent = "Co ma pokazywać ten kafelek? Nazwa ustawi się automatycznie.";
    card.querySelectorAll(".tile-pick-list").forEach((x) => x.remove());
    const list = document.createElement("div");
    list.className = "tile-pick-list";
    TILE_CATALOG.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tile-pick-item" + (c.id === curSrc ? " on" : "");
      b.textContent = c.label + (c.unit ? "  (" + c.unit + ")" : "");
      b.onclick = () => {
        dialog.hidden = true;
        list.remove();
        dialog.classList.remove("with-list");
        $("confirmOk").hidden = false;
        // Krok 1: wartość + automatyczna nazwa (można ją zaraz zmienić w kroku 2).
        tileCfg[tileId] = { label: c.label, src: c.id };
        tileSave();
        tileApplyLabels();
        tileRender(state);
        updatePulpit(state);
        // Krok 2 (opcjonalny): zmiana nazwy — wpisana wartość wchodzi prosto do pola.
        askInput("Zmień nazwę kafelka (możesz zostawić automatyczną)", c.label, "text", c.label).then((name) => {
          const auto = c.label;
          const label = name === null ? auto : (String(name).trim().slice(0, 16) || auto);
          const cur = tileCfg[tileId];
          if (cur) {
            cur.label = label;
            tileSave();
            tileApplyLabels();
          }
          nativeNotifyAlert("Kafelki HUD", "„" + label + "” pokazuje teraz: " + auto + ".");
        });
      };
      list.appendChild(b);
    });
    card.insertBefore(list, $("confirmActions"));
    const ok = $("confirmOk");
    // Jeden przycisk ANULUJ wystarczy — ok ma ten sam tekst co cancel, więc go chowamy.
    ok.hidden = true;
    ok.onclick = () => { ok.hidden = false; dialog.hidden = true; list.remove(); dialog.classList.remove("with-list"); };
    $("confirmCancel").onclick = () => { ok.hidden = false; dialog.hidden = true; list.remove(); dialog.classList.remove("with-list"); };
    // „with-list" = karta na całą wysokość ekranu, sama lista się przewija,
    // przyciski ANULUJ/OK zostają przypięte na dole karty (zawsze widoczne).
    dialog.classList.add("with-list");
    dialog.hidden = false;
  }

  // Zeruje detekcję upadku. graceMs > 0 ustawia karencję, w której alarm w ogóle nie ocenia stanu
  // (używane po (re)połączeniu BLE, żeby samo podłączenie nie uruchamiało alarmu).
  function crashResetDetect(graceMs) {
    crashState.stoppedSince = 0;
    crashState.movingSince = 0;
    crashState.lastMoveMs = 0;
    crashState.stateAt = 0;
    crashState.moveHits = 0;
    crashState.gpsMovingSince = 0;
    crashState.lastFastMs = 0;
    crashState.tiltBlocked = false;
    crashState.armedAt = graceMs > 0 ? Date.now() + graceMs : 0;
    if (graceMs > 0) crashState.gPeak = 0;
  }

  function crashLoad() {
    // Stan alarmu zawsze startuje czysty — resztki z poprzedniej sesji nie mogą uzbroić alarmu.
    crashState.latched = false;
    crashState.muteUntil = 0;
    crashState.gPeak = 0;
    crashResetDetect(60000);
    try {
      const c = JSON.parse(localStorage.getItem(CRASH_KEY) || "null");
      if (c && typeof c === "object") crashCfg = Object.assign({}, crashCfg, c);
    } catch (e) { /* ignore */ }
    // Normalizacja numerów: obsługa starego formatu (tablica stringów) i nowego ({num,label}).
    if (!Array.isArray(crashCfg.nums)) crashCfg.nums = [];
    crashCfg.nums = crashCfg.nums.map((n) => {
      if (typeof n === "string") return { num: n.trim(), label: "" };
      if (n && typeof n === "object" && typeof n.num === "string") {
        return { num: n.num.trim(), label: typeof n.label === "string" ? n.label.trim() : "" };
      }
      return null;
    }).filter((n) => n && n.num).slice(0, 3);
    crashCfg.delay = Math.max(10, Math.min(60, Number(crashCfg.delay) || 30));
    crashCfg.repeat = Math.max(1, Math.min(5, Number(crashCfg.repeat) || 3));
    crashCfg.layers = Math.max(1, Math.min(3, Number(crashCfg.layers) || 3));
    crashCfg.callIdx = Math.max(0, Math.min(crashCfg.nums.length - 1, Number(crashCfg.callIdx) || 0));
    crashRenderSettings();
  }

  function crashSave() {
    try { localStorage.setItem(CRASH_KEY, JSON.stringify(crashCfg)); } catch (e) { /* ignore */ }
    crashRenderSettings();
  }

  // Czytelny opis wybranej czułości: co dokładnie ją uruchamia i czego wymaga.
  function crashRenderLayerInfo() {
    const box = $("crashLayerInfo");
    const dots = $("crashLayerDots");
    const info = {
      1: {
        head: "Tylko pewny upadek",
        body: "Motocykl leży (przechył ponad 65°), silnik zgaszony i koło stoi. Wymaga połączonej olejarki — bez BLE ta warstwa nie działa. Najmniej fałszywych alarmów. Wstrzymane, gdy obsługujesz telefon (otwarte okno albo widok inny niż HUD).",
      },
      2: {
        head: "Pewny upadek + nagłe zatrzymanie",
        body: "Działa jak warstwa 1, a dodatkowo łapie sytuację, gdy telefon się przekręcił i przechył kłamie: motocykl jechał z prędkością ≥ 25 km/h i nagle stanął z zgaszonym silnikiem (w ≤ 3 s) — zwykłe dojechanie na postój tego nie łapie. Też wymaga połączonej olejarki. Wstrzymane przy obsłudze telefonu. Zalecane.",
      },
      3: {
        head: "Maksymalna (także bez olejarki)",
        body: "Działa jak warstwa 2, a dodatkowo próbuje wykryć upadek z samego telefonu: pik przeciążenia powyżej 2,4 g po potwierdzonej jeździe GPS. Jedyna warstwa działająca także bez połączenia BLE — najbardziej podatna na fałszywe alarmy.",
      },
    };
    const d = info[crashCfg.layers] || info[2];
    if (box) {
      box.innerHTML = '<b>' + d.head + "</b><span>" + d.body + "</span>";
    }
    if (dots) {
      dots.replaceChildren(...[1, 2, 3].map((n) => {
        const s = document.createElement("i");
        s.className = "dot" + (n <= crashCfg.layers ? " on" : "");
        return s;
      }));
    }
  }

  function crashNumText(entry) {    if (!entry) return "";
    return (entry.label ? entry.label + " · " : "") + entry.num;
  }

  function crashRenderSettings() {
    const onBtn = $("crashOnBtn");
    if (onBtn) { onBtn.textContent = crashCfg.on ? "WŁ" : "WYŁ"; onBtn.classList.toggle("on", crashCfg.on); }
    const layBtn = $("crashLayerBtn");
    if (layBtn) {
      const names = { 1: "1 — Tylko pewny", 2: "2 — Pewny + jazda", 3: "3 — Maksymalna" };
      layBtn.textContent = names[crashCfg.layers] || names[2];
      layBtn.classList.toggle("hot", crashCfg.layers >= 3);
    }
    crashRenderLayerInfo();
    const callBtn = $("crashCallBtn");
    if (callBtn) { callBtn.textContent = crashCfg.call ? "WŁ" : "WYŁ"; callBtn.classList.toggle("on", crashCfg.call); }
    const delayOut = $("crashDelayOut");
    if (delayOut) delayOut.textContent = crashCfg.delay;
    const repOut = $("crashRepeatOut");
    if (repOut) repOut.textContent = crashCfg.repeat;
    const list = $("crashNumList");
    if (list) {
      if (!crashCfg.nums.length) {
        const empty = document.createElement("p");
        empty.className = "setting-hint";
        empty.textContent = "Brak numerów — dodaj numer, do którego ma dzwonić i pójść SMS.";
        list.replaceChildren(empty);
      } else {
        list.replaceChildren(...crashCfg.nums.map((entry, i) => {
          const row = document.createElement("div");
          row.className = "setting-line crash-num-row";
          const span = document.createElement("output");
          span.textContent = crashNumText(entry);
          const isPicked = i === crashCfg.callIdx;
          const pick = document.createElement("button");
          pick.type = "button";
          pick.className = "crash-icon-btn" + (isPicked ? " on" : "");
          // Ikona słuchawki (SVG) — jednolity wygląd, brak zależności od emoji/motywu.
          pick.innerHTML = isPicked
            ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.7.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.7.1.4 0 .8-.2 1l-2.3 2.1Z" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.7.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.7.1.4 0 .8-.2 1l-2.3 2.1Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
          pick.title = isPicked ? "Ten numer dzwoni po alarmie" : "Ustaw, żeby ten numer dzwonił po alarmie";
          pick.onclick = () => { crashCfg.callIdx = i; crashSave(); };
          const del = document.createElement("button");
          del.type = "button";
          del.className = "crash-icon-btn crash-del-btn";
          // Ikona kosza (SVG) — ten sam rozmiar i styl co słuchawka.
          del.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7A1.5 1.5 0 0 0 17 19.5L18 7M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          del.title = "Usuń numer";
          del.onclick = () => crashRemoveNumber(i);
          row.append(span, pick, del);
          return row;
        }));
      }
      const callHint = $("crashCallHint");
      if (callHint) {
        if (!crashCfg.nums.length) {
          callHint.textContent = "";
        } else if (crashCfg.nums.length === 1) {
          callHint.textContent = "Jest tylko jeden numer, więc zawsze dzwoni „" + crashNumText(crashCfg.nums[0]) + "”. Dodaj drugi (➕), żeby wybierać.";
        } else {
          callHint.textContent = "Dzwoni numer „" + crashNumText(crashCfg.nums[crashCfg.callIdx]) + "”. Dotknij słuchawki przy innym, żeby zmienić. SMS idzie do wszystkich.";
        }
      }
    }
    const permHint = $("crashPermHint");
    if (permHint) {
      const b = bridge();
      const ok = b && typeof b.hasAlertPermissions === "function" ? !!b.hasAlertPermissions() : false;
      permHint.textContent = ok ? "Uprawnienia SMS i telefonu: przyznane." : "Uprawnienia SMS i telefonu: brak — dotknij „Przyznaj uprawnienia”.";
      permHint.classList.toggle("err", !ok);
    }
  }

  function crashRemoveNumber(i) {
    const entry = crashCfg.nums[i];
    if (!entry) return;
    askConfirm("Usunąć numer " + crashNumText(entry) + "?", true, "USUŃ", "Alarm wypadku").then((yes) => {
      if (!yes) return;
      crashCfg.nums.splice(i, 1);
      // Przy usunięciu wybranego numeru przełącz dzwonienie na następny z listy.
      if (i === crashCfg.callIdx) crashCfg.callIdx = Math.min(i, Math.max(0, crashCfg.nums.length - 1));
      else if (i < crashCfg.callIdx) crashCfg.callIdx--;
      crashCfg.callIdx = Math.max(0, Math.min(Math.max(0, crashCfg.nums.length - 1), crashCfg.callIdx));
      crashSave();
    });
  }

  function crashAddNumber() {
    if (crashCfg.nums.length >= 3) {
      nativeNotifyAlert("Alarm wypadku", "Można zapisać maksymalnie 3 numery.");
      return;
    }
    askInput("Numer telefonu (np. +48601234567)", "+48", "tel").then((v) => {
      if (v == null) return;
      const num = String(v).trim().replace(/\s+/g, "");
      if (!/^\+?\d{7,15}$/.test(num)) {
        nativeNotifyAlert("Alarm wypadku", "To nie wygląda na numer telefonu.");
        return;
      }
      askInput("Podpis numeru (np. Żona, Kolega) — opcjonalnie", "np. Żona", "text").then((l) => {
        const label = l == null ? "" : String(l).trim().slice(0, 24);
        crashCfg.nums.push({ num, label });
        if (crashCfg.nums.length === 1) crashCfg.callIdx = 0;
        crashSave();
      });
    });
  }

  function crashTest() {
    if (!crashCfg.nums.length) {
      nativeNotifyAlert("Alarm wypadku", "Najpierw dodaj numer telefonu.");
      return;
    }
    const msg = "DripTronic TEST alarmu — wszystko działa. " + crashLocationText();
    const b = bridge();
    if (!b || typeof b.sendCrashAlert !== "function") {
      nativeNotifyAlert("Alarm wypadku", "Ta wersja aplikacji nie ma mostka alarmu — zaktualizuj apkę.");
      return;
    }
    if (typeof b.hasAlertPermissions === "function" && !b.hasAlertPermissions()) {
      nativeNotifyAlert("Alarm wypadku", "Brak uprawnień — najpierw dotknij „Przyznaj uprawnienia”.");
      return;
    }
    const sent = crashSendSms(msg);
    nativeNotifyAlert("Alarm wypadku",
      sent ? "Wysłano SMS testowy na " + crashCfg.nums.length + " numer(y). Sprawdź telefon."
           : "Nie udało się wysłać SMS — sprawdź uprawnienia i numer.");
  }

  function crashLocationText() {
    if (haPos && haPos.coords) {
      const lat = Math.round(haPos.coords.latitude * 1e6) / 1e6;
      const lon = Math.round(haPos.coords.longitude * 1e6) / 1e6;
      return "Pozycja: https://maps.google.com/?q=" + lat + "," + lon;
    }
    return "Pozycja: brak GPS w tej chwili.";
  }

  function crashSendSms(message) {
    const b = bridge();
    if (!b || typeof b.sendCrashAlert !== "function") return false;
    const nums = crashCfg.nums.map((n) => n.num);
    try { return !!b.sendCrashAlert(JSON.stringify(nums), message, false); } catch (e) { return false; }
  }

  function crashCall() {
    if (!crashCfg.nums.length) return;
    const b = bridge();
    if (!b || typeof b.sendCrashAlert !== "function") return;
    const idx = crashCfg.nums[crashCfg.callIdx] ? crashCfg.callIdx : 0;
    const target = crashCfg.nums[idx];
    if (!target) return;
    // Dzwoni tylko wybrany numer: wysyłamy listę z jednym elementem i prosimy o połączenie.
    try { b.sendCrashAlert(JSON.stringify([target.num]), "", true); } catch (e) { /* ignore */ }
  }

  function crashSound(on) {
    const b = bridge();
    if (b && typeof b.crashSound === "function") { try { b.crashSound(!!on); } catch (e) { /* ignore */ } }
    if (b && typeof b.crashAlarm === "function") { try { b.crashAlarm(!!on); } catch (e) { /* ignore */ } }
  }

  // Geofence: brak ruchu ~12 s i niewielki promień od punktu alarmu.
  function crashNoMovementSecs() {
    if (!crashState.at || !haPos || !haPos.coords) return 0;
    return Math.floor((Date.now() - crashState.at) / 1000);
  }

  function crashTrigger(reason) {
    if (crashState.latched) return;
    crashState.latched = true;
    crashState.at = Date.now();
    crashState.count = 0;
    // Przejdź na HUD, żeby pełnoekranowy alarm był widoczny.
    document.body.classList.remove("settings", "charts", "profiles", "errors", "trips", "info", "pulpit");
    const ov = $("crashOverlay");
    if (ov) ov.hidden = false;
    const why = $("crashWhy");
    if (why) why.textContent = reason;
    crashSound(true);
    crashState.count = crashCfg.delay;
    const tick = () => {
      crashState.count--;
      const out = $("crashCount");
      if (out) out.textContent = String(Math.max(0, crashState.count));
      if (crashState.count <= 0) {
        clearInterval(crashState.timer);
        crashState.timer = null;
        crashEscalate();
      }
    };
    const out0 = $("crashCount");
    if (out0) out0.textContent = String(crashState.count);
    crashState.timer = setInterval(tick, 1000);
  }

  function crashEscalate() {
    const msg = "DripTronic ALERT: prawdopodobny wypadek! Zadzwoń do mnie. " + crashLocationText();
    let n = 0;
    const send = () => {
      crashSendSms(msg);
      if (crashCfg.call && n === 0) crashCall();
      n++;
      if (n < crashCfg.repeat) {
        crashState.smsTimer = setTimeout(send, 60000);
      }
    };
    send();
    const out = $("crashCount");
    if (out) out.textContent = "SMS WYSŁANY";
    const line = document.querySelector(".crash-count-line");
    if (line) line.childNodes[0].textContent = "Alarm wysłany. ";
    const note = document.querySelector(".crash-note");
    if (note) note.textContent = "Wciśnij „JEST OK”, aby zakończyć alarm i rozłączyć połączenie.";
  }

  function crashCancel() {
    const ov = $("crashOverlay");
    if (ov) ov.hidden = true;
    if (crashState.timer) { clearInterval(crashState.timer); crashState.timer = null; }
    if (crashState.smsTimer) { clearTimeout(crashState.smsTimer); crashState.smsTimer = null; }
    crashSound(false);
    crashState.latched = false;
    crashState.at = 0;
    crashState.gPeak = 0;
    crashState.stoppedSince = 0;
    // Blokada po anulowaniu: nie uzbrajaj alarmu od nowa od razu (np. telefon leży przekręcony).
    crashState.muteUntil = Date.now() + 3 * 60 * 1000;
    // Zakończ połączenie alarmowe, jeśli trwa — inaczej dzwoni dalej.
    const b = bridge();
    if (b && typeof b.crashEndCall === "function") { try { b.crashEndCall(); } catch (e) { /* ignore */ } }
    nativeNotifyAlert("Olejarka", "Anulowano alarm wypadku. Alarm nie uzbroi się ponownie przez 3 minuty.");
  }

  // Czy użytkownik obsługuje teraz telefon? Otwarte okno dialogowe albo widok inny niż HUD
  // (Ustawienia, Wykresy, Profile, Błędy, Tripy, Info, Pulpit) oznacza, że telefon jest w ręku —
  // podniesiony telefon nie może udawać upadku.
  function crashUiBusy() {
    const dlg = $("confirmDialog");
    if (dlg && !dlg.hidden) return true;
    const c = document.body.classList;
    return c.contains("settings") || c.contains("charts") || c.contains("profiles") ||
      c.contains("errors") || c.contains("trips") || c.contains("info") ||
      c.contains("pulpit") || c.contains("hud-editing");
  }

  // Ocenia warunki upadku na podstawie stanu BLE (wołane przy każdym pakiecie).
  function crashCheckBle(s) {
    if (!crashCfg.on || crashState.latched || !s) return;
    // Po ręcznym anulowaniu alarm nie może się od razu uzbroić od nowa.
    if (crashState.muteUntil && Date.now() < crashState.muteUntil) return;
    // Alarm działa WYŁĄCZNIE przy połączonej olejarce — bez BLE stan jest pusty (rpm/speed = 0)
    // i wyglądałby jak upadek. To była przyczyna fałszywego alarmu przy starcie.
    if (!connected) { crashState.stoppedSince = 0; crashState.lastMoveMs = 0; return; }
    const now = Date.now();
    // Warstwy 1-2 wstrzymane, dopóki użytkownik obsługuje telefon (wpisywanie tankowania,
    // ustawienia, okna dialogowe). Zerujemy liczniki, a przechył musi wrócić blisko bazy.
    if (crashUiBusy()) {
      crashState.stoppedSince = 0;
      crashState.moveHits = 0;
      crashState.movingSince = 0;
      crashState.lastFastMs = 0;
      crashState.tiltBlocked = true;
      return;
    }
    // Karencja po (re)połączeniu BLE: świeżo podłączony regulator nie może uzbroić alarmu,
    // dopóki dane się nie ustabilizują. Przerwanie i powrót BLE nie uruchamia alarmu.
    if (!crashState.armedAt || now < crashState.armedAt) { crashState.stoppedSince = 0; return; }
    // Tylko świeże dane (stan z ostatnich 3 s) — stare/puste też dają rpm=0, speed=0.
    if (!crashState.stateAt || now - crashState.stateAt > 3000) { crashState.stoppedSince = 0; return; }
    const speed = Number.isFinite(s.speed) ? s.speed : 0;
    const rpm = Number.isFinite(s.rpm) ? s.rpm : 0;
    const tilt = Number.isFinite(hudTiltSmooth) ? Math.abs(hudTiltSmooth) : NaN;
    // Po powrocie z obsługi telefonu warstwa przechyłu czeka, aż telefon wróci blisko bazy
    // (przechył ≤ 40°) — trzymany pod kątem telefon nie może uzbroić alarmu.
    if (crashState.tiltBlocked && Number.isFinite(tilt) && tilt <= 40) crashState.tiltBlocked = false;
    // Ruch musi być potwierdzony przez kilka pakietów z rzędu (nie pojedynczy szum prędkości),
    // inaczej warstwa 2 strzelałaby po chwilowym błędzie odczytu.
    if (speed >= 5) {
      crashState.moveHits = Math.min(5, (crashState.moveHits || 0) + 1);
      if (crashState.moveHits >= 3) crashState.movingSince = now;
    } else {
      crashState.moveHits = 0;
    }
    // Czas ostatniej prędkości ≥ 25 km/h — do odróżnienia nagłego zatrzymania od zwykłego dojechania.
    if (speed >= 25) crashState.lastFastMs = now;
    const wasMoving = crashState.movingSince > 0 && now - crashState.movingSince < 120000;
    // Warstwa 1 (najpewniejsza): motocykl leży (przechył > 65°), silnik zgaszony, koło stoi.
    if (!crashState.tiltBlocked && tilt > 65 && rpm === 0 && speed < 2) {
      crashTrigger("przechył " + Math.round(tilt) + "° · obroty 0 · prędkość 0");
      return;
    }
    // Warstwa 2: brak wiarygodnego przechyłu (telefon przekręcony/wypadł z uchwytu),
    // ale motocykl FAKTYCZNIE jechał i NAGLE stanął z zgaszonym silnikiem — wymaga warstwy ≥ 2.
    // Nagłe zatrzymanie = prędkość ≥ 25 km/h jeszcze ≤ 3 s temu; zwykłe dojechanie (hamowanie)
    // tego nie łapie, więc gaszenie silnika na postoju nie daje już fałszywego alarmu.
    if (crashCfg.layers >= 2 && wasMoving && rpm === 0 && speed < 2) {
      if (!crashState.stoppedSince && crashState.lastFastMs && now - crashState.lastFastMs <= 3000) {
        crashState.stoppedSince = now;
      }
      // Utrzymane zatrzymanie przez 5 s, żeby nie łapać chwilowego spadku odczytu.
      if (crashState.stoppedSince && now - crashState.stoppedSince >= 5000) {
        crashTrigger("nagłe zatrzymanie po jeździe · obroty 0");
      }
    } else {
      crashState.stoppedSince = 0;
    }
  }

  // Warstwa 3: tylko telefon — pik przeciążenia + spadek prędkości GPS.
  function crashCheckPhone(gMag, gpsSpeed) {
    if (!crashCfg.on || crashState.latched || crashCfg.layers < 3) return;
    if (crashState.muteUntil && Date.now() < crashState.muteUntil) return;
    // Karencja po (re)połączeniu/uruchomieniu — telefon nie może uzbroić alarmu od razu.
    if (!crashState.armedAt || Date.now() < crashState.armedAt) return;
    const now = Date.now();
    // Warstwa telefonu ma sens TYLKO gdy telefon/motocykl faktycznie się poruszał (GPS).
    // Bez potwierdzonego ruchu GPS (albo bez GPS w ogóle) każde podniesienie telefonu
    // dawałoby fałszywy alarm — dlatego wymagamy świeżej prędkości GPS >= 10 km/h.
    if (Number.isFinite(gpsSpeed) && gpsSpeed >= 10) crashState.gpsMovingSince = now;
    const gpsWasMoving = crashState.gpsMovingSince > 0 && now - crashState.gpsMovingSince < 90000;
    if (!gpsWasMoving) { crashState.gPeak = 0; return; }
    if (!crashState.gPeak || gMag > crashState.gPeak) crashState.gPeak = gMag;
    // Próg podniesiony do 3,5 G — realny szlif daje mocny pik, podniesienie telefonu nie.
    if (gMag < 3.5) return;
    // Pik G + GPS ~0 (stanęło) => podejrzenie upadku.
    if (Number.isFinite(gpsSpeed) && gpsSpeed > 8) return;
    // Pik musi być świeży (w ostatnich 5 s), a nie z przed chwili.
    if (now - crashState.gPeak > 5000) return;
    crashTrigger("pik przeciążenia " + fmt(gMag, 1) + " G · brak ruchu");
  }

  function crashTickRide(s) {
    if (!crashCfg.on || crashState.latched) return;
    crashCheckBle(s);
  }

  function updateStatus(text, isConnected) {
    const was = connected;
    connected = isConnected;
    const statusText = text || (connected ? "Połączono BLE" : "Utracono BLE");
    $("subtitle").textContent = statusText;
    const statusLabel = $("hdrStatusText");
    if (statusLabel) statusLabel.textContent = statusText;
    const hdr = $("hdrStatus");
    if (hdr) {
      hdr.textContent = statusText;
      hdr.className = "hdr-status " + (connected ? "ok" : "lost");
    }
    $("dot").classList.toggle("lost", !connected);
    renderBtSignal();
    renderWarnings(null);
    refreshBleLock();
    if (was && !connected) {
      dateSyncPending = true;   // po rozłączeniu następne połączenie znów zsynchronizuje datę
      haOnBleLost();
      // Po rozłączeniu natychmiast przelicz HUD/pulpit — live wartości (fuel rate) wracają do „—".
      if (state) updateHud(state);
      // Reset detekcji upadku — bez BLE dane są nieaktualne i nie mogą uzbroić alarmu.
      crashResetDetect(0);
      if (alerts.bt) nativeNotifyAlert("Olejarka — utracono BLE", "Rozłączono z olejarką — ponawiam połączenie.");
    } else if (!was && connected) {
      dateSyncPending = true;   // data poleci na pierwszym pakiecie stanu
      // Po (re)połączeniu alarm dostaje karencję, żeby samo podłączenie BLE go nie uruchamiało.
      crashResetDetect(60000);
      haOnBleResume();
    }
  }

  const BLE_ONLY = [
    "#settingsParams button",
    "#settingsParams .setting-tappable",
    "#settingsMode button",
    "#autoBtn",
    "#rainBtn",
    "#spdSrcBtn",
    "#bleedBtn",
    "#calPanel button",
    "#profileSaveBtn",
    "#profileRestoreBtn",
    "#errorsReadBtn",
    "#errorsClearBtn",
    "[data-command]",
  ];

  function refreshBleLock() {
    const off = !connected;
    document.body.classList.toggle("settings-offline", off);
    const nodes = document.querySelectorAll(BLE_ONLY.join(","));
    for (const el of nodes) el.disabled = off;
    settingsHint();
  }

  function settingsHint() {
    const el = $("settingsOfflineHint");
    if (!el) return;
    if (!document.body.classList.contains("settings-offline")) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = config
      ? "Brak połączenia BLE — ustawienia tylko do odczytu (ostatnio wczytana konfiguracja)."
      : "Brak połączenia BLE — konfiguracja nie jest dostępna. Połącz się, aby edytować ustawienia.";
  }

  window.refreshSettingsHint = settingsHint;

  let btRssi = null;

  function renderBtSignal() {
    const el = $("btSig");
    if (!el) return;
    const show = connected && btRssi != null;
    el.hidden = !show;
    if (!show) {
      el.dataset.bars = "0";
      el.removeAttribute("data-grade");
      el.title = "";
      return;
    }
    const r = btRssi;
    let bars;
    if (r >= -55) bars = 4;
    else if (r >= -65) bars = 3;
    else if (r >= -75) bars = 2;
    else if (r >= -85) bars = 1;
    else bars = 0;
    el.dataset.bars = String(bars);
    if (bars >= 4) el.removeAttribute("data-grade");
    else if (bars > 1) el.setAttribute("data-grade", "weak");
    else el.setAttribute("data-grade", "none");
    el.title = "BT " + r + " dBm";
  }

  function updateKmHints() {
    kmHints.forEach((hint) => {
      const imp = Number(config && config.intervalImp);
      const wheel = Number(config && config.wheelCircumCm);
      if (!Number.isFinite(imp) || !Number.isFinite(wheel) || wheel <= 0) {
        hint.textContent = "";
        return;
      }
      const km = (imp * wheel) / 100000;
      hint.textContent = Math.round(imp) + " imp";
      if (hint._distanceOutput) {
        hint._distanceOutput.textContent = "co " + km.toFixed(2).replace(".", ",") + " km";
      }
    });
  }

function applyActuatorVisibility() {
    let t = NaN;
    try {
      if (localStorage.getItem("olejarTypUser") === "1") {
        const stored = localStorage.getItem("olejarTyp");
        if (stored === "0" || stored === "1") t = Number(stored);
      }
    } catch (e) { /* ignore */ }
    if (!Number.isFinite(t) && config) {
      if (Number(config.actuatorType) === 1) t = 1;
    }
    if (!Number.isFinite(t)) t = 1;
    const isPump = t === 1;
    const unknown = !Number.isFinite(t);
    document.querySelectorAll("#settingsParams .setting-row[data-actuator]").forEach((row) => {
      row.hidden = unknown ? false : row.dataset.actuator !== (isPump ? "pump" : "valve");
    });
    if ($("calPanel")) $("calPanel").hidden = unknown ? false : !isPump;
    if ($("bleedBtn")) $("bleedBtn").hidden = unknown ? false : !!isPump;
    updateCalEst();
  }

  function updateCalEst() {
    if (!$("calEst") || !$("calImpOut")) return;
    const ml = config && Number(config.pumpFlowMlPer1k) > 0 ? calTestImp * config.pumpFlowMlPer1k / 1000 : null;
    $("calEst").textContent = ml === null ? "?" : fmt(ml, 1);
  }

  function commitCalImp() {
    try { localStorage.setItem("olejarCalImp", String(calTestImp)); } catch (e) { /* ignore */ }
    $("calImpOut").textContent = calTestImp;
    updateCalEst();
  }

  function calIdle() {
    $("calTestBtn").textContent = "Uruchom test";
    $("calTestBtn").classList.remove("danger");
  }

  function calStart() {
    if (calTimer) return;
    command("SET TEST " + calTestImp);
    $("calTestBtn").textContent = "PRZERWIJ";
    $("calTestBtn").classList.add("danger");
    const pumpMs = config && Number(config.pumpRunMs) > 0 ? config.pumpRunMs : 80;
    calTimer = setTimeout(() => { calTimer = null; calFinish(); }, calTestImp * (pumpMs + 500) + 2000);
  }

  function calStop() {
    if (calTimer) { clearTimeout(calTimer); calTimer = null; }
    command("SET TEST");
    calIdle();
  }

  function calFinish() {
    calIdle();
    askInput("Test zakończony. Ile ml podała pompka? (pomiar ze strzykawki)", "np. 4,4").then((raw) => {
      if (raw === null || raw === undefined || raw === "") return;
      applyCalibration(raw);
    });
  }

  function calSave() {
    if (calTimer) return;
    if (!$("calMl").value.trim()) return;
    applyCalibration($("calMl").value);
  }

  function applyCalibration(raw) {
    const ml = parseFloat(String(raw).replace(",", "."));
    if (!(ml > 0)) return;
    let wydaj = Math.min(25, Math.max(1, Math.round(ml * 1000 / calTestImp * 10) / 10));
    askConfirm("Ustawić wydajność pompki na " + fmtNum(wydaj) + " ml/1k imp?\nPomiar: " + fmt(ml, 2) + " ml / " + calTestImp + " imp.", false, "ZAPISZ", "Kalibracja").then((ok) => {
      if (!ok) return;
      config.pumpFlowMlPer1k = wydaj;
      setValue("WYDAJ", wydaj);
      updateCalEst();
      $("calMl").value = "";
    });
  }

  function settingRow(item) {
    const row = document.createElement("div");
    row.className = "setting-row";
    if (item.showFor) row.dataset.actuator = item.showFor;
    const label = document.createElement("div");
    label.className = "setting-label";
    label.textContent = item.label;
    const controls = document.createElement("div");
    controls.className = "setting-controls";
    const line = document.createElement("div");
    line.className = "setting-line";
    const out = document.createElement("output");
    const min = item.min ?? 0;
    const max = item.max ?? 999999;
    const ready = () => connected && !!config && config[item.field] !== undefined && config[item.field] !== null;
    const show = () => {
      out.textContent = ready() ? fmtNum(config[item.field]) + (item.unit ? " " + item.unit : "") : "—";
      updateKmHints();
    };
    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.onclick = () => { if (!ready()) return; config[item.field] = Math.max(min, config[item.field] - item.step); show(); setValue(item.key, config[item.field]); };
    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.onclick = () => { if (!ready()) return; config[item.field] = Math.min(max, config[item.field] + item.step); show(); setValue(item.key, config[item.field]); };
    out.classList.add("setting-tappable");
    out.onclick = () => {
      if (!ready()) return;
      askInput(item.label + " (" + (item.unit || "wartość") + ")", fmtInput(config[item.field])).then((raw) => {
        if (raw === null || raw === undefined) return;
        const v = parseFloat(String(raw).replace(",", "."));
        if (!Number.isFinite(v)) return;
        const clamped = Math.min(max, Math.max(min, v));
        config[item.field] = clamped;
        show();
        setValue(item.key, clamped);
      });
    };
    line.append(minus, out, plus);
    controls.append(line);
    row.append(label, controls);
    if (item.field === "intervalImp") {
      const hint = document.createElement("small");
      hint.className = "setting-hint";
      hint._distanceOutput = out;
      row.append(hint);
      kmHints.push(hint);
    }
    show();
    return row;
  }

  function cycleRow(label, field, key, options, format) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const name = document.createElement("div");
    name.className = "setting-label";
    name.textContent = label;
    const button = document.createElement("button");
    const cycReady = () => connected && !!config && config[field] !== undefined && config[field] !== null;
    const show = () => {
      button.textContent = cycReady() ? format(cycleInitValue(config[field], field)) : "—";
    };
    button.onclick = () => {
      if (!cycReady()) return;
      const val = cycleInitValue(config[field], field);
      const i = options.indexOf(val);
      const next = options[(i < 0 ? 0 : i + 1) % options.length];
      config[field] = next;
      button.textContent = format(config[field]);
      if (field === "actuatorType") {
        try {
          localStorage.setItem("olejarTyp", String(config[field]));
          localStorage.setItem("olejarTypUser", "1");
        } catch (e) { /* ignore */ }
      }
      setValue(key, config[field]);
      if (field === "actuatorType") applyActuatorVisibility();
    };
    show();

  function cycleInitValue(raw, field) {
    if (field === "actuatorType") {
      let explicit = false;
      try { explicit = localStorage.getItem("olejarTypUser") === "1"; } catch (e) { /* ignore */ }
      if (explicit) {
        let stored = null;
        try { stored = localStorage.getItem("olejarTyp"); } catch (e) { /* ignore */ }
        if (stored === "0" || stored === "1") return Number(stored);
      }
      return 1;
    }
    return raw;
  }
    row.append(name, button);
    return row;
  }

  function renderConfig(c) {
    config = c || null;
    if (c && Number(c.actuatorType) === 1) {
      try {
        if (localStorage.getItem("olejarTypUser") !== "1") localStorage.setItem("olejarTyp", "1");
      } catch (e) { /* ignore */ }
    }
    kmHints = [];
    const params = [
      ["Interwał dawki", "intervalImp", "CEL", "imp", 5],
      ["Czas otwarcia zaworu", "valveOpenMs", "ZAWOR", "ms", 100, "valve"],
      ["Czas pompki", "pumpRunMs", "POMPC", "ms", 10, "pump"],
      ["Impulsy pompki", "pumpImp", "POMPI", "", 1, "pump"],
      ["Limit dzienny", "dailyLimitImp", "LIMIT", "imp", 1],
      ["Obwód koła", "wheelCircumCm", "OBWOD", "cm", 1],
      ["Min. prędkość", "minSpeedKph", "VMIN", "km/h", 1],
      ["Wydajność pompki", "pumpFlowMlPer1k", "WYDAJ", "ml/1k imp", 0.1, "pump"],
      ["Pojemność zbiornika", "tankCapacityMl", "POJEMN", "ml", 1],
      ["Kalibracja temp. zewn.", "tempCal", "KALI", "°C", 0.5, null, -20, 20],
      ["Kalibracja paliwa", "fuelCal", "FCAL", "%", 1, null, 50, 200],
      ["Kalibracja dystansu", "distCal", "DCAL", "%", 1, null, 50, 200],
    ];
    $("settingsParams").replaceChildren(...params.map((p) => settingRow({ label: p[0], field: p[1], key: p[2], unit: p[3], step: p[4], showFor: p[5], min: p[6], max: p[7] })));
    $("settingsMode").replaceChildren(
      cycleRow("Interwał awaryjny", "emergencyMin", "AWARYJNY", [0, 5, 10, 15, 30, 60], (v) => v ? "co " + v + " min" : "Wył."),
      cycleRow("Typ siłownika", "actuatorType", "TYP", [0, 1], (v) => v ? "Pompka Webasto" : "Elektrozawór"),
    );
    applyActuatorVisibility();
    updateKmHints();
    refreshBleLock();
  }

  function showHud() {
    document.body.classList.remove("settings", "charts", "profiles", "errors", "trips", "pulpit");
    $("hudBtn").classList.add("on");
    alignHeadActions();
  }

  function showSettings() {
    document.body.classList.add("settings");
    document.body.classList.remove("charts", "profiles", "errors", "trips", "pulpit");
    $("hudBtn").classList.remove("on");
  }

  function showCharts() {
    document.body.classList.add("charts");
    document.body.classList.remove("settings", "profiles", "errors", "trips", "info", "pulpit");
    $("hudBtn").classList.remove("on");
    scheduleDrawCharts();
  }

  function showProfiles() {
    lockOnLeave();
    document.body.classList.add("profiles");
    document.body.classList.remove("settings", "charts", "errors", "trips", "info", "pulpit");
    $("hudBtn").classList.remove("on");
    pushView("profiles");
  }

  function showErrors() {
    lockOnLeave();
    document.body.classList.add("errors");
    document.body.classList.remove("settings", "charts", "profiles", "trips", "info", "pulpit");
    $("hudBtn").classList.remove("on");
    pushView("errors");
  }

  function showPulpit() {
    lockOnLeave();
    document.body.classList.add("pulpit");
    document.body.classList.remove("settings", "charts", "profiles", "errors", "trips", "info");
    $("hudBtn").classList.remove("on");
    updatePulpit(state);
    pushView("pulpit");
  }

  function pushView(v) {
    const b = bridge();
    if (b && typeof b.setView === "function") b.setView(v);
  }

  function toggleMenu(force) {
    const panel = $("menuPanel");
    const open = force !== undefined ? force : panel.hidden;
    panel.hidden = !open;
    $("menuBtn").classList.toggle("on", open);
  }

  function applyLock() {
    document.body.classList.toggle("locked", locked);
    const lockBtn = $("settingsLock");
    lockBtn.textContent = locked ? "🔒 Ustawienia zablokowane" : "🔓 Zablokuj ustawienia";
    lockBtn.classList.toggle("unlocked", !locked);
  }

  function lockOnLeave() {
    if (document.body.classList.contains("settings")) {
      locked = true;
      applyLock();
    }
  }

  function showHud() {
    lockOnLeave();
    document.body.classList.remove("settings", "charts", "profiles", "errors", "trips", "info", "pulpit");
    $("hudBtn").classList.add("on");
    requestAnimationFrame(alignHeadActions);
    pushView("hud");
    tileApplyLabels();
    tileRender(state);
  }

  function showSettings() {
    document.body.classList.add("settings");
    document.body.classList.remove("charts", "profiles", "errors", "trips", "info", "pulpit");
    $("hudBtn").classList.remove("on");
    pushView("settings");
  }

  function showCharts() {
    lockOnLeave();
    document.body.classList.add("charts");
    document.body.classList.remove("settings", "profiles", "errors", "trips", "info", "pulpit");
    $("hudBtn").classList.remove("on");
    scheduleDrawCharts();
    pushView("charts");
  }

  let drawChartsRaf = 0;
  function scheduleDrawCharts() {
    if (drawChartsRaf) return;
    drawChartsRaf = requestAnimationFrame(() => {
      drawChartsRaf = 0;
      drawCharts();
    });
  }

  $("hudBtn").onclick = showHud;
  $("menuBtn").onclick = () => toggleMenu();
  document.addEventListener("click", (event) => {
    if (event.target.closest("#menuPanel, #menuBtn")) return;
    toggleMenu(false);
  });
  document.querySelectorAll(".settings-group").forEach((group) => {
    const summary = group.querySelector(":scope > summary");
    if (!summary) return;
    summary.addEventListener("click", () => {
      const willOpen = !group.open;
      document.querySelectorAll(".settings-group[open]").forEach((openGroup) => {
        if (openGroup !== group) openGroup.open = false;
      });
      if (willOpen) {
        requestAnimationFrame(() => {
          const scroller = group.closest(".settings-scroll");
          if (!scroller) return;
          const delta = group.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollBy({ top: delta, behavior: "instant" });
        });
      }
    });
  });
  document.querySelectorAll("#menuPanel [data-nav]").forEach((item) => {
    item.onclick = () => {
      const nav = item.dataset.nav;
      if (nav === "settings") showSettings();
      else if (nav === "pulpit") showPulpit();
      else if (nav === "charts") showCharts();
      else if (nav === "profiles") showProfiles();
      else if (nav === "errors") showErrors();
      else if (nav === "trips") showTrips();
      else if (nav === "info") showInfo();
      toggleMenu(false);
    };
  });
  // Pulpit: przyciski serwisu łańcucha.
  const refuelAddBtn = $("refuelAddBtn");
  if (refuelAddBtn) refuelAddBtn.onclick = () => refuelOpen();
  const refuelTopUpBtn = $("refuelTopUpBtn");
  if (refuelTopUpBtn) refuelTopUpBtn.onclick = () => refuelTopUp();
  const wifiSetupBtn = $("wifiSetupBtn");
  if (wifiSetupBtn) wifiSetupBtn.onclick = () => wifiSetup();
  const refuelHistBtn = $("refuelHistBtn");
  if (refuelHistBtn) refuelHistBtn.onclick = () => refuelHistoryOpen();
  const refuelCloseBtn = $("refuelCloseBtn");
  if (refuelCloseBtn) refuelCloseBtn.onclick = () => refuelHistoryClose();
  // Kafelki HUD: tryb edycji z Ustawień.
  const hudEditBtn = $("hudEditBtn");
  if (hudEditBtn) hudEditBtn.onclick = () => hudEditStart();
  const hudEditOkBtn = $("hudEditOkBtn");
  if (hudEditOkBtn) hudEditOkBtn.onclick = () => hudEditStop();
  const hudTilesResetBtn = $("hudTilesResetBtn");
  if (hudTilesResetBtn) hudTilesResetBtn.onclick = () => tileResetAll();
  document.querySelectorAll("#hud .hud-count[data-tile]").forEach((el) => {
    el.addEventListener("click", () => {
      if (!hudEditMode) return;
      tileEditOpen(el.dataset.tile);
    });
  });
  const crashTileTestBtn = $("crashTileTestBtn");
  if (crashTileTestBtn) crashTileTestBtn.onclick = () => crashTest();
  const crashOnBtn = $("crashOnBtn");
  if (crashOnBtn) crashOnBtn.onclick = () => {
    crashCfg.on = !crashCfg.on;
    if (!crashCfg.on && crashState.latched) crashCancel();
    crashSave();
    updatePulpit(state);
    if (crashCfg.on) { const b = bridge(); if (b && b.requestAlertPermissions) b.requestAlertPermissions(); }
  };
  const crashLayerBtn = $("crashLayerBtn");
  if (crashLayerBtn) crashLayerBtn.onclick = () => { crashCfg.layers = crashCfg.layers >= 3 ? 1 : crashCfg.layers + 1; crashSave(); };
  const crashCallBtn = $("crashCallBtn");
  if (crashCallBtn) crashCallBtn.onclick = () => { crashCfg.call = !crashCfg.call; crashSave(); };
  const crashDelayMinus = $("crashDelayMinus");
  if (crashDelayMinus) crashDelayMinus.onclick = () => { crashCfg.delay = Math.max(10, crashCfg.delay - 5); crashSave(); };
  const crashDelayPlus = $("crashDelayPlus");
  if (crashDelayPlus) crashDelayPlus.onclick = () => { crashCfg.delay = Math.min(60, crashCfg.delay + 5); crashSave(); };
  const crashRepeatMinus = $("crashRepeatMinus");
  if (crashRepeatMinus) crashRepeatMinus.onclick = () => { crashCfg.repeat = Math.max(1, crashCfg.repeat - 1); crashSave(); };
  const crashRepeatPlus = $("crashRepeatPlus");
  if (crashRepeatPlus) crashRepeatPlus.onclick = () => { crashCfg.repeat = Math.min(5, crashCfg.repeat + 1); crashSave(); };
  const crashAddNumBtn = $("crashAddNumBtn");
  if (crashAddNumBtn) crashAddNumBtn.onclick = () => crashAddNumber();
  const crashPermBtn = $("crashPermBtn");
  if (crashPermBtn) crashPermBtn.onclick = () => {
    const b = bridge();
    if (b && b.requestAlertPermissions) b.requestAlertPermissions();
    setTimeout(crashRenderSettings, 1200);
  };
  const crashTestBtn = $("crashTestBtn");
  if (crashTestBtn) crashTestBtn.onclick = () => crashTest();
  const crashCancelBtn = $("crashCancelBtn");
  if (crashCancelBtn) crashCancelBtn.onclick = () => crashCancel();
  const chainDoneBtn = $("chainDoneBtn");
  if (chainDoneBtn) chainDoneBtn.onclick = () => {
    if (connected && Number.isFinite(state.distance)) {
      chainLastKm = state.distance;
      pulpitPersist();
      updatePulpit(state);
      nativeNotifyAlert("Olejarka — serwis zapisany", "Łańcuch oznaczony jako serwisowany. Następny serwis za " + chainIntKm + " km.");
    }
  };
  const chainIntMinus = $("chainIntMinus");
  const chainIntPlus = $("chainIntPlus");
  const bumpChain = (d) => {
    chainIntKm = Math.max(100, Math.min(2000, chainIntKm + d));
    const out = $("chainIntOut");
    if (out) out.textContent = chainIntKm;
    pulpitPersist();
    updatePulpit(state);
  };
  if (chainIntMinus) chainIntMinus.onclick = () => bumpChain(-50);
  if (chainIntPlus) chainIntPlus.onclick = () => bumpChain(50);
  {
    const out = $("chainIntOut");
    if (out) out.textContent = chainIntKm;
  }
  const THEME_NAMES = ["dark", "amoled", "light"];
  const THEME_NEXT_ICON = { dark: "◐", amoled: "☀", light: "☾" };
  function currentTheme() {
    return document.documentElement.dataset.theme || "dark";
  }
  function applyTheme(name) {
    document.documentElement.dataset.theme = name;
    const tb = $("themeBtn");
    if (tb) tb.textContent = THEME_NEXT_ICON[name];
    try { localStorage.setItem("olejarTheme", name); } catch (e) {}
  }
  function persistThemeAuto() {
    try {
      localStorage.setItem("olejarThemeAuto", JSON.stringify({ auto: autoTheme, thr: themeThr, hyst: themeHyst, dark: autoDark }));
    } catch (e) {}
  }
  function updateThemeOuts() {
    if ($("thrOut")) $("thrOut").textContent = themeThr;
    if ($("hystOut")) $("hystOut").textContent = themeHyst;
  }
  function updateThemeUi() {
    const b = $("themeAutoBtn");
    if (b) b.textContent = autoTheme ? "WŁ" : "WYŁ";
    const db = $("themeDarkBtn");
    if (db) db.textContent = autoDark === "amoled" ? "AMOLED" : "CIEMNY";
  }
  function applyAutoTheme() {
    if (!autoTheme || lastLux === null) return;
    let want = themeLightState;
    if (want === true && lastLux < themeThr - themeHyst) want = false;
    else if (want === false && lastLux > themeThr + themeHyst) want = true;
    else if (want === null) want = lastLux >= themeThr;
    if (want !== themeLightState) {
      themeLightState = want;
      applyTheme(want ? "light" : autoDark);
    }
  }
  function setAutoTheme(on) {
    autoTheme = on;
    themeLightState = null;
    persistThemeAuto();
    updateThemeUi();
    applyAutoTheme();
  }
  window.nativeSetLux = function (lux) {
    const v = Number(lux);
    if (!Number.isFinite(v) || v < 0) return;
    luxSmooth = luxSmooth === null ? v : luxSmooth + 0.35 * (v - luxSmooth);
    if (Math.abs(v - luxSmooth) < 0.5) luxSmooth = v;
    lastLux = luxSmooth;
    if ($("luxLive")) $("luxLive").textContent = Math.round(v) + " lx";
    applyAutoTheme();
    applyAutoBright();
  };
  $("themeAutoBtn").onclick = () => setAutoTheme(!autoTheme);
  $("themeDarkBtn").onclick = () => {
    autoDark = autoDark === "amoled" ? "dark" : "amoled";
    persistThemeAuto();
    updateThemeUi();
    applyAutoTheme();
  };
  $("thrMinus").onclick = () => { themeThr = Math.max(0, themeThr - 250); persistThemeAuto(); updateThemeOuts(); applyAutoTheme(); };
  $("thrPlus").onclick = () => { themeThr = Math.min(50000, themeThr + 250); persistThemeAuto(); updateThemeOuts(); applyAutoTheme(); };
  $("hystMinus").onclick = () => { themeHyst = Math.max(0, themeHyst - 100); persistThemeAuto(); updateThemeOuts(); applyAutoTheme(); };
  $("hystPlus").onclick = () => { themeHyst = Math.min(5000, themeHyst + 100); persistThemeAuto(); updateThemeOuts(); applyAutoTheme(); };
  {
    const savedTheme = (function () {
      try { return localStorage.getItem("olejarTheme") || "dark"; } catch (e) { return "dark"; }
    })();
    applyTheme(THEME_NAMES.indexOf(savedTheme) >= 0 ? savedTheme : "dark");
  }
  $("themeBtn").onclick = () => {
    if (autoTheme) setAutoTheme(false);
    const next = THEME_NAMES[(THEME_NAMES.indexOf(currentTheme()) + 1) % THEME_NAMES.length];
    applyTheme(next);
  };
  function persistBright() {
    try {
      localStorage.setItem("olejarBright", JSON.stringify({ auto: autoBright, min: brMin, max: brMax, mul: brMul }));
    } catch (e) {}
  }
  function updateBrightUi() {
    if ($("brAutoBtn")) $("brAutoBtn").textContent = autoBright ? "WŁ" : "WYŁ";
    if ($("brMinOut")) $("brMinOut").textContent = brMin;
    if ($("brMaxOut")) $("brMaxOut").textContent = brMax;
    if ($("brMulOut")) $("brMulOut").textContent = brMul;
  }
  function sendBright(frac) {
    if (frac >= 0) frac = Math.max(0, Math.min(1, frac));
    lastBrightSent = frac;
    const b = bridge();
    if (b && b.setBrightness) b.setBrightness(frac);
  }
  const BR_DEADBAND = 0.08;
  const BR_MIN_GAP_MS = 4000;
  const BR_JUMP = 0.25;
  function applyAutoBright() {
    if (!autoBright) return;
    let target;
    if (lastLux === null) target = brMin / 100;
    else if (lastLux <= themeThr - themeHyst) target = brMin / 100;
    else if (lastLux >= themeThr + themeHyst) target = brMax / 100;
    else {
      const mix = (lastLux - (themeThr - themeHyst)) / (2 * themeHyst);
      target = (brMin + (brMax - brMin) * mix) / 100;
    }
    target = Math.min(1, target * (brMul / 100));
    if ($("brLive")) $("brLive").textContent = Math.round(target * 100) + "%";
    const prev = lastBrightSent;
    if (prev !== null && Math.abs(target - prev) < BR_DEADBAND) return;
    const jump = prev !== null && Math.abs(target - prev) >= BR_JUMP;
    const now = Date.now();
    if (prev !== null && !jump && now - lastBrightMs < BR_MIN_GAP_MS) return;
    lastBrightMs = now;
    sendBright(target);
  }
  function setAutoBright(on) {
    autoBright = on;
    persistBright();
    updateBrightUi();
    if (autoBright) {
      lastBrightSent = null;
      applyAutoBright();
    } else {
      lastBrightSent = null;
      sendBright(-1);
    }
  }
  $("brAutoBtn").onclick = () => setAutoBright(!autoBright);
  $("brMinMinus").onclick = () => { brMin = Math.max(0, brMin - 5); persistBright(); updateBrightUi(); applyAutoBright(); };
  $("brMinPlus").onclick = () => { brMin = Math.min(100, brMin + 5); persistBright(); updateBrightUi(); applyAutoBright(); };
  $("brMaxMinus").onclick = () => { brMax = Math.max(0, brMax - 5); persistBright(); updateBrightUi(); applyAutoBright(); };
  $("brMaxPlus").onclick = () => { brMax = Math.min(100, brMax + 5); persistBright(); updateBrightUi(); applyAutoBright(); };
  $("brMulMinus").onclick = () => { brMul = Math.max(50, brMul - 5); persistBright(); updateBrightUi(); applyAutoBright(); };
  $("brMulPlus").onclick = () => { brMul = Math.min(150, brMul + 5); persistBright(); updateBrightUi(); applyAutoBright(); };
  {
    const saved = (function () {
      try { return JSON.parse(localStorage.getItem("olejarBright") || "null"); } catch (e) { return null; }
    })();
    if (saved && typeof saved.min === "number") {
      brMin = Math.max(0, Math.min(100, saved.min));
      if (typeof saved.max === "number") brMax = Math.max(brMin, Math.min(100, saved.max));
      if (typeof saved.mul === "number") brMul = Math.max(50, Math.min(150, saved.mul));
      autoBright = !!saved.auto;
    }
  }
  updateBrightUi();
  if (autoBright) {
    lastBrightSent = null;
    applyAutoBright();
  }
  try {
    const saved = JSON.parse(localStorage.getItem("olejarThemeAuto") || "null");
    if (saved && typeof saved.thr === "number") {
      themeThr = saved.thr;
      if (typeof saved.hyst === "number") themeHyst = saved.hyst;
      if (saved.dark === "amoled" || saved.dark === "dark") autoDark = saved.dark;
      autoTheme = !!saved.auto;
    }
  } catch (e) {}
  updateThemeOuts();
  updateThemeUi();
  $("settingsLock").onclick = () => {
    locked = !locked;
    applyLock();
  };
  $("hudPump").onclick = () => command("LUBS");
  $("hudMode").onclick = () => {
    modeIdx = (modeIdx + 1) % RIDE_MODES.length;
    const dm = RIDE_MODES[modeIdx];
    try { localStorage.setItem("olejarDose", dm.id); } catch (e) {}
    console.log("[hudMode] tryb → " + dm.id + (dm.mlt ? " (×" + dm.mlt + ")" : "") + " ble=" + !!bridge());
    if (dm.kind === "rain") command("RAIN_ON");
    else { command("RAIN_OFF"); command("DOSE_" + dm.id); }
    doseUi(dm);
    showModeToast(dm.toast);
  };
  bindLongReset($("hudTrip").closest(".hud-count"), "RST_TRIP", "Na pewno wyzerować TRIP?");
  bindLongReset($("hudAvg").closest(".hud-count"), "RST_FUEL", "Na pewno wyzerować AVG / zużycie paliwa?");
  bindLongReset($("hudFuelBar").querySelector(".hud-vbar-icon"), "RST_FUEL_LVL", "Na pewno ustawić poziom paliwa na pełny zbiornik?", refuelFromTankReset);
  $("autoBtn").onclick = () => command(state && state.auto ? "AUTO_OFF" : "AUTO_ON");
  $("rainBtn").onclick = () => command(state && state.rain ? "RAIN_OFF" : "RAIN_ON");
  const spdBtn = $("spdSrcBtn");
  if (spdBtn) spdBtn.onclick = () => command(state && state.spdObd ? "SPD_HALL" : "SPD_OBD");
  $("bleedBtn").onclick = () => command("BLEED_ON");
  $("calImpMinus").onclick = () => { calTestImp = Math.max(CAL_MIN, calTestImp - CAL_STEP); commitCalImp(); };
  $("calImpPlus").onclick = () => { calTestImp = Math.min(CAL_MAX, calTestImp + CAL_STEP); commitCalImp(); };
  $("calTestBtn").onclick = () => (calTimer ? calStop() : calStart());
  $("calImpOut").textContent = calTestImp;
  updateCalEst();
  $("calSaveBtn").onclick = calSave;
  const RESET_CONFIRM = {
    RST_TRIP: { msg: "Wyzerować przebieg TRIP?", danger: false },
    RST_FUEL: { msg: "Wyzerować AVG / zużycie paliwa?", danger: false },
    RST_DD: { msg: "Wyzerować dawki dzisiaj?", danger: false },
    RST_ZD: { msg: "Wyzerować dzisiejsze zużycie oleju?", danger: false },
    RST_IMP: { msg: "Wyzerować licznik impulsów?", danger: false },
    RST_OIL: { msg: "Ustawić poziom oleju na pełny zbiornik?", danger: false },
    RST_DT: { msg: "Wyzerować łączne dawki? Licznik nie będzie mógł wrócić.", danger: true },
    RST_ZT: { msg: "Wyzerować łączne zużycie oleju? Licznik nie będzie mógł wrócić.", danger: true },
    LUBS: { msg: "Wykonać ręczną dawkę oleju?", danger: false },
  };
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.onclick = () => {
      const cmd = button.dataset.command;
      if (cmd === "DATE") {
        sendDateNow({ report: true });
        return;
      }
      const entry = RESET_CONFIRM[cmd];
      if (entry) {
        askConfirm(entry.msg, entry.danger).then((accepted) => { if (accepted) command(cmd); });
        return;
      }
      command(cmd);
    };
  });

  applyLock();

  document.querySelectorAll("[data-metric]").forEach((b) => b.onclick = () => {
    const m = b.dataset.metric;
    if (chartActive.has(m)) {
      if (chartActive.size === 1) return;
      chartActive.delete(m);
    } else {
      chartActive.add(m);
    }
    document.querySelectorAll("[data-metric]").forEach((x) => x.classList.toggle("on", chartActive.has(x.dataset.metric)));
    drawCharts();
  });
  const scaleSel = $("chartScale");
  if (scaleSel) scaleSel.addEventListener("change", () => {
    const v = parseInt(scaleSel.value, 10);
    if (isFinite(v) && v > 0) chartRangeMin = v;
    applySelection(chartRangeMin * 60000);
  });
  // Szybki powrót do pełnego wybranego dnia (lub 24 h, gdy dzień nie wybrany).
  const fullBtn = $("chartsFull");
  if (fullBtn) fullBtn.onclick = () => {
    chartRangeMin = 1440;
    const scale = $("chartScale");
    if (scale) scale.value = CHART_DEFAULT_RANGE_MIN;
    if (chartDayStart && chartDayEnd && chartDayEnd > chartDayStart) {
      setChartWindow(chartDayStart, chartDayEnd - chartDayStart);
      chartProbe = null;
      drawCharts();
    } else {
      applySelection(1440 * 60000);
    }
  };
  setupChartDate();
  $("chartsReset").onclick = () => {
    const names = Array.from(chartActive).map((k) => CHART_META[k].label).join(", ");
    askConfirm("Wyczyścić wykresy dla: " + names + "?\nCała historia 7 dni tych serii zostanie usunięta.", false, "WYCZYŚĆ", "Wykresy").then((accepted) => {
      if (!accepted) return;
      for (const k of chartActive) {
        chartBuf[k].length = 0;
        chartHist[k].length = 0;
      }
      markHistDirty();
      chartLastSampleAt = 0;
      resetChartView();
      drawCharts();
      const b = bridge();
      if (b && b.requestState) {
        b.requestState();
        setTimeout(() => { const bb = bridge(); if (bb && bb.requestState) bb.requestState(); }, 3000);
      }
    });
  };
  $("chartsSave").onclick = () => {
    let any = false;
    for (const key in chartBuf) if (chartBuf[key].length >= 2) any = true;
    for (const key in chartHist) if (chartHist[key].length >= 1) any = true;
    if (!any) return;
    const b = bridge();
    if (!b || !b.saveChart) return;
    b.saveChart($("chartCanvas").toDataURL("image/png"));
  };
  $("tiltCalBtn").onclick = () => { const b = bridge(); if (b && b.calibrateTilt) b.calibrateTilt(); };
  $("tiltClearBtn").onclick = () => { const b = bridge(); if (b && b.clearTilt) b.clearTilt(); };

  const PROFILE_FIELDS = [
    ["intervalImp", "CEL"],
    ["valveOpenMs", "ZAWOR"],
    ["pumpRunMs", "POMPC"],
    ["pumpImp", "POMPI"],
    ["dailyLimitImp", "LIMIT"],
    ["wheelCircumCm", "OBWOD"],
    ["minSpeedKph", "VMIN"],
    ["pumpFlowMlPer1k", "WYDAJ"],
    ["tankCapacityMl", "POJEMN"],
    ["emergencyMin", "AWARYJNY"],
    ["actuatorType", "TYP"],
    ["tempCal", "KALI"],
    ["fuelCal", "FCAL"],
  ];

  function collectProfile() {
    const p = { format: "olejarka-kopia", app: "native-v0.6", createdAt: new Date().toISOString(), config: {} };
    if (!config) {
      askConfirm("Nie można zapisać kopii — konfiguracja nie jest jeszcze wczytana. Połącz się z olejarką i spróbuj ponownie.", false, "OK", "Kopia ustawień").then(() => {});
      return;
    }
    PROFILE_FIELDS.forEach(([field]) => {
      if (config[field] !== undefined && config[field] !== null) p.config[field] = Number(config[field]);
    });
    try {
      const t = localStorage.getItem("olejarTyp");
      if (t === "0" || t === "1") p.prefTyp = Number(t);
      const ci = localStorage.getItem("olejarCalImp");
      if (ci) p.calImp = Number(ci);
    } catch (e) { /* ignore */ }
    return p;
  }

  function saveProfile() {
    const p = collectProfile();
    if (!p || Object.keys(p.config).length === 0) return;
    const b = bridge();
    if (!b || !b.saveProfile) return;
    b.saveProfile(JSON.stringify(p, null, 2));
  }

  window.nativeApplyProfile = function (raw) {
    if (typeof raw !== "string") return;
    let profile;
    try {
      profile = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!profile || profile.format !== "olejarka-kopia" || !profile.config || typeof profile.config !== "object") {
      askConfirm("Ten plik nie jest kopią ustawień olejarki.", false, "OK", "Kopia ustawień").then(() => {});
      return;
    }
    if (!connected || !config) {
      askConfirm("Aby przywrócić ustawienia, najpierw połącz się z olejarką (połączono w nagłówku).", false, "OK", "Kopia ustawień").then(() => {});
      return;
    }
    askConfirm("Przywrócić ustawienia smarowania z kopii?\nWysłane zostaną do olejarki wszystkie parametry z pliku.", false, "PRZYWRÓĆ", "Kopia ustawień").then((accepted) => {
      if (!accepted) return;
      const applied = [];
      PROFILE_FIELDS.forEach(([field, key]) => {
        const v = profile.config[field];
        if (v === undefined || v === null) return;
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        setValue(key, num);
        if (config[field] !== undefined) config[field] = num;
        applied.push(field);
      });
      if (profile.prefTyp === 0 || profile.prefTyp === 1) {
        try {
          localStorage.setItem("olejarTyp", String(profile.prefTyp));
          localStorage.setItem("olejarTypUser", "1");
        } catch (e) { /* ignore */ }
      }
      if (Number.isFinite(Number(profile.calImp))) {
        try { localStorage.setItem("olejarCalImp", String(profile.calImp)); } catch (e) { /* ignore */ }
        calTestImp = Math.min(CAL_MAX, Math.max(CAL_MIN, Number(profile.calImp)));
        $("calImpOut").textContent = calTestImp;
      }
      applyActuatorVisibility();
      if (profile.config.actuatorType !== undefined) applyActuatorVisibility();
      askConfirm("Przywrócono " + applied.length + " parametrów.", false, "OK", "Kopia ustawień").then(() => {});
    });
  };

  $("profileSaveBtn").onclick = saveProfile;
  $("profileRestoreBtn").onclick = () => { const b = bridge(); if (b && b.pickProfile) b.pickProfile(); };

  const DTC_NAMES = {
    "P0100": "Usterka przepływomierza powietrza (MAF)",
    "P0101": "MAF poza zakresem",
    "P0102": "MAF niski sygnał",
    "P0103": "MAF wysoki sygnał",
    "P0110": "Usterka czujnika temp. dolotu (IAT)",
    "P0113": "IAT wysoki sygnał",
    "P0115": "Usterka czujnika temp. płynu (ECT)",
    "P0117": "ECT niski sygnał",
    "P0118": "ECT wysoki sygnał",
    "P0120": "Usterka czujnika położenia przepustnicy (TPS)",
    "P0122": "TPS niski sygnał",
    "P0123": "TPS wysoki sygnał",
    "P0130": "Usterka czujnika O2 (bank 1, cz. 1)",
    "P0131": "O2 bank1 niski napięcie",
    "P0133": "O2 bank1 wolna reakcja",
    "P0135": "Usterka grzałki czujnika O2",
    "P0170": "Usterka trymowania paliwa (bank 1)",
    "P0171": "Za uboga mieszanka (bank 1)",
    "P0172": "Za bogata mieszanka (bank 1)",
    "P0300": "Losowe wypadanie zapłonu",
    "P0301": "Wypadanie zapłonu — cylinder 1",
    "P0302": "Wypadanie zapłonu — cylinder 2",
    "P0303": "Wypadanie zapłonu — cylinder 3",
    "P0304": "Wypadanie zapłonu — cylinder 4",
    "P0320": "Usterka sygnału rozrusznika/obrotów",
    "P0335": "Usterka czujnika położenia wału (CKP)",
    "P0340": "Usterka czujnika położenia wałka (CMP)",
    "P0400": "Usterka recyrkulacji spalin (EGR)",
    "P0420": "Niska skuteczność katalizatora (bank 1)",
    "P0440": "Usterka układu odparowania paliwa",
    "P0500": "Usterka czujnika prędkości (VSS)",
    "P0505": "Usterka układu biegu jałowego (IAC)",
    "P0560": "Usterka napięcia zasilania",
    "P0601": "Błąd pamięci ECU",
    "P0606": "Błąd procesora ECU",
    "P0700": "Usterka skrzyni/przekładni",
    "P1101": "Diagnostyka MAF poza zakresem",
    "P2100": "Usterka siłownika przepustnicy (elektronicznej)",
    "P2122": "Czujnik położenia pedału niski sygnał",
    "P2127": "Czujnik położenia pedału niski sygnał (2)",
    "P2135": "Niespójność sygnałów TPS",
  };

  function dtcLabel(code) {
    return DTC_NAMES[code] || "Kod nieznany — sprawdź w instrukcji serwisowej";
  }

  function renderDtc(text) {
    const status = $("errorsStatus");
    const list = $("errorsList");
    if (!status || !list) return;
    if (!text) {
      status.textContent = "Czytanie kodów…";
      return;
    }
    const t = text.trim();
    if (t === "OK") {
      status.textContent = "Brak kodów błędów (ECU nie zgłasza usterek).";
      list.innerHTML = '<div class="dtc-empty">Brak błędów 🎉</div>';
      return;
    }
    if (t === "ERR") {
      status.textContent = "ECU zwróciło negatywną odpowiedź (mode 03/04 nieobsługiwany lub ECU wyłączone).";
      list.innerHTML = "";
      return;
    }
    const codes = t.split(",").map((c) => c.trim()).filter(Boolean);
    status.textContent = codes.length + " kod(ów) błędów.";
    list.innerHTML = codes.map((c) =>
      '<div class="dtc-item"><span class="dtc-code">' + c + '</span><span class="dtc-name">' + dtcLabel(c) + "</span></div>"
    ).join("");
  }

  $("errorsReadBtn").onclick = () => {
    if (!connected) {
      askConfirm("Najpierw połącz się z olejarką, aby odczytać błędy.", false, "OK", "Błędy OBD").then(() => {});
      return;
    }
    const b = bridge();
    if (!b || !b.readDtc) return;
    renderDtc(null);
    b.readDtc();
  };
  $("errorsClearBtn").onclick = () => {
    if (!connected) {
      askConfirm("Najpierw połącz się z olejarką, aby skasować błędy.", false, "OK", "Błędy OBD").then(() => {});
      return;
    }
    askConfirm("Skasować wszystkie kody błędów (Mode 04)?\nBłędy znikną, ale po ponownym wystąpieniu usterki ECU zgłosi je z powrotem.", true, "KASUJ", "Błędy OBD").then((accepted) => {
      if (!accepted) return;
      const b = bridge();
      if (!b || !b.clearDtc) return;
      renderDtc(null);
      b.clearDtc();
    });
  };

  function alignHeadActions() {
    const acts = $("headActions");
    const hud = $("hudBtn");
    const menu = $("menuBtn");
    const theme = $("themeBtn");
    const side = document.querySelector(".hud-oil-side");
    if (!acts || !hud || !menu || !theme || !side) return;
    const hudVertical = document.body.classList.contains("hud-vert");
    const sRect = side.getBoundingClientRect();
    if (!hudVertical) {
      if (sRect.width < 40) return;
      const native = document.body.classList.contains("native");
      const gap = native ? 10 : 6;
      const rightEdge = window.innerWidth - (native ? 38 : 20);
      const w = Math.round(rightEdge - sRect.left - menu.offsetWidth - theme.offsetWidth - gap * 2 - 1);
      if (Number.isFinite(w) && w > 0) {
        hud.style.width = w + "px";
        hud.style.minWidth = w + "px";
      }
    }

    const tilt = $("hudTilt");
    const center = document.querySelector(".hud-center");
    const gauge = $("gauge");
    if (tilt && center && gauge) {
      const cRect = center.getBoundingClientRect();
      const gRect = gauge.getBoundingClientRect();
      if (cRect.width > 0) tilt.style.width = Math.round(cRect.width) + "px";
      if (gRect.height > 0) {
        const tiltLine = hudVertical ? (gRect.width <= 150 ? 0.77 : 0.82) : 0.92;
        const arcLineY = gRect.top + gRect.height * tiltLine + vuCfg.y;
        tilt.style.top = Math.round(arcLineY - cRect.top) + "px";
        tilt.style.bottom = "auto";
      }
      tilt.style.transform = "translateX(calc(-50% + " + vuCfg.x + "px))";
    }

    const tempBar = $("hudTempBar");
    const fuelBar = $("hudFuelBar");
    const leftGrid = document.querySelector(".hud-obd-side .hud-data-grid");
    const rightGrid = document.querySelector(".hud-oil-side .hud-data-grid");
    if (tempBar && fuelBar && leftGrid && rightGrid && center) {
      const cRect = center.getBoundingClientRect();
      const lg = leftGrid.getBoundingClientRect();
      const rg = rightGrid.getBoundingClientRect();
      let h = Math.round(Math.min(lg.bottom, rg.bottom) - Math.max(lg.top, rg.top)) - 4;
      if (h <= 0) return;
      const top = Math.round(Math.max(lg.top, rg.top) - cRect.top);
      tempBar.hidden = false;
      fuelBar.hidden = false;
      tempBar.style.top = top + "px";
      tempBar.style.height = h + "px";
      tempBar.style.left = Math.round(lg.right - cRect.left + 6) + "px";
      fuelBar.style.top = top + "px";
      fuelBar.style.height = h + "px";
      fuelBar.style.left = Math.round(rg.left - cRect.left - 6 - 40) + "px";
    }
  }
  window.addEventListener("resize", alignHeadActions);
  window.addEventListener("orientationchange", () => setTimeout(alignHeadActions, 120));
  alignHeadActions();
  window.nativeSetDtc = renderDtc;
  bindChartsGestures();
  setInterval(sampleTilt, CHART_SAMPLE_MS);
  setInterval(drawCharts, 500);
  window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushHist(); });
  window.addEventListener("pagehide", flushHist);

  function sampleTilt() {
    const el = $("chartCanvas");
    if (el && Number.isFinite(liveTilt)) {
      const now = performance.now();
      const cutoff = now - CHART_FINE_MS;
      const v = connected ? liveTilt : 0;
      chartBuf.tilt.push({ t: now, v });
      if (connected) histPush("tilt", Date.now(), v);
      while (chartBuf.tilt.length && chartBuf.tilt[0].t < cutoff) chartBuf.tilt.shift();
      if (chartBuf.tilt.length > CHART_MAX_POINTS) chartBuf.tilt.splice(0, chartBuf.tilt.length - CHART_MAX_POINTS);
      markHistDirty();
    }
  }

  window.nativeSetState = function (value) { state = value; crashState.stateAt = Date.now(); syncDateOnce(); updateHud(value); };
  // Zrównoważony raz po (re)połączeniu: przy pierwszym pakiecie stanu olejarka dostaje
  // dzisiejszą datę i (gdy się zmieniła) zeruje liczniki dzienne. Idempotentne.
  function syncDateOnce() {
    if (!connected || !dateSyncPending) return;
    dateSyncPending = false;
    sendDateNow();
  }
  // --- Znacznik czasu ostatniej synchronizacji zegara ---
  const DATE_SYNC_KEY = "olejarDateSync";
  function fmtStamp(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" : "") + n;
    return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function renderDateSync() {
    const txt = dateSyncAt > 0
      ? ("Ostatnia synchronizacja: " + fmtStamp(dateSyncAt))
      : "Ostatnia synchronizacja: —";
    document.querySelectorAll(".date-sync-info").forEach((el) => { el.textContent = txt; });
  }
  function dateSyncLoad() {
    try {
      const v = parseInt(localStorage.getItem(DATE_SYNC_KEY) || "", 10);
      if (Number.isFinite(v) && v > 0) dateSyncAt = v;
    } catch (e) { /* ignore */ }
    renderDateSync();
  }
  // Wysyła datę do regulatora i zapisuje znacznik czasu. Bez połączenia nie zmyśla
  // „synchronizacji", która nie dotarła; przycisk może wtedy o tym powiadomić (report).
  function sendDateNow(opts) {
    const b = bridge();
    if (!b || !b.sendDate) return false;
    if (!connected) {
      if (opts && opts.report) {
        nativeNotifyAlert("Data", "Olejarka nie jest połączona — data wyśle się po połączeniu.", true);
      }
      return false;
    }
    try {
      b.sendDate();
      dateSyncAt = Date.now();
      try { localStorage.setItem(DATE_SYNC_KEY, String(dateSyncAt)); } catch (e) { /* ignore */ }
      renderDateSync();
      return true;
    } catch (e) { return false; }
  }
  window.nativeSetBtRssi = function (rssi) {
    btRssi = (typeof rssi === "number" && rssi < 0) ? rssi : null;
    renderBtSignal();
  };
  window.crashRefreshPerms = function () { crashRenderSettings(); };

  window.nativeSetGPeak = function (g) {    if (!Number.isFinite(g)) return;
    const gpsSpeed = haPos && haPos.coords && Number.isFinite(haPos.coords.speed) ? haPos.coords.speed * 3.6 : NaN;
    crashCheckPhone(g, gpsSpeed);
  };

  window.nativeSetTilt = function (deg) {    if (!Number.isFinite(deg)) { liveTilt = Number.NaN; }
    else { liveTilt = deg; }
    const el = $("tiltLive");
    if (el) el.textContent = Number.isFinite(liveTilt) ? Math.round(liveTilt) + "°" : "—";
    updateHudTilt();
  };

  let vuBuilt = false;
  function vuSegs(pan, n) {
    const segs = [];
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i");
      s.className = "vu-seg";
      pan.appendChild(s);
      segs.push(s);
    }
    return segs;
  }
  const VU_SEGS = 15;
  let leanFull = vuCfg.lean;
  let hudVuSegs = null;

  function updateHudTilt() {
    const wrap = $("hudTilt");
    if (!wrap) return;
    if (!Number.isFinite(liveTilt)) {
      hudTiltSmooth = Number.NaN;
      hudTiltPeak = 0;
      hudTiltPeakAt = 0;
      wrap.hidden = true;
      return;
    }
    if (!vuBuilt) {
      const l = $("hudVuL");
      const r = $("hudVuR");
      if (l && r) {
        const ls = vuSegs(l, VU_SEGS);
        const rs = vuSegs(r, VU_SEGS);
        hudVuSegs = { l: ls, r: rs };
      }
      vuBuilt = true;
    }
    wrap.hidden = false;
    hudTiltSmooth = Number.isFinite(hudTiltSmooth) ? hudTiltSmooth + (liveTilt - hudTiltSmooth) * 0.35 : liveTilt;
    crashTickRide(state);
    const deg = connected ? hudTiltSmooth : 0;
    const abs = Math.abs(deg);
    const tNow = performance.now();
    if (Math.abs(deg) >= Math.abs(hudTiltPeak) - 0.05) {
      hudTiltPeak = deg;
      hudTiltPeakAt = tNow;
    } else if (tNow - hudTiltPeakAt >= HUD_PEAK_HOLD_MS) {
      hudTiltPeak = deg;
      hudTiltPeakAt = tNow;
    }
    const holding = tNow - hudTiltPeakAt < HUD_PEAK_HOLD_MS;
    const lit = Math.min(VU_SEGS, Math.round((abs / leanFull) * VU_SEGS));
    const peakLit = Math.min(VU_SEGS, Math.round((Math.abs(hudTiltPeak) / leanFull) * VU_SEGS));
    if (hudVuSegs) {
      const lightLeft = deg <= -0.5;
      const lightRight = deg >= 0.5;
      const holdLeft = holding && hudTiltPeak <= -0.5;
      const holdRight = holding && hudTiltPeak >= 0.5;
      for (const pan of [hudVuSegs.l, hudVuSegs.r]) {
        const isLeft = pan === hudVuSegs.l;
        const litNow = (isLeft ? lightLeft : lightRight) ? lit : 0;
        const holdIdx = (isLeft ? holdLeft : holdRight) ? peakLit - 1 : -1;
        for (let i = 0; i < VU_SEGS; i++) {
          const on = i < litNow || i === holdIdx;
          pan[i].classList.toggle("on", on);
          pan[i].classList.toggle("mid", on && i >= VU_SEGS * 0.3 && i < VU_SEGS * 0.7);
          pan[i].classList.toggle("hot", on && i >= VU_SEGS * 0.7);
        }
      }
    }
    const shown = Math.max(-leanFull, Math.min(leanFull, Math.round(deg)));
    const livePct = Math.min(94, Math.max(6, 50 + (shown / leanFull) * 50));
    const peakShown = Math.max(-leanFull, Math.min(leanFull, Math.round(hudTiltPeak)));
    const peakPct = Math.min(94, Math.max(6, 50 + (peakShown / leanFull) * 50));
    const pAbs = Math.abs(hudTiltPeak);
    const returning = connected && pAbs >= 0.5 && abs < pAbs - 0.5;
    let liveLeft = livePct;
    if (returning && Math.abs(livePct - peakPct) < 12) {
      liveLeft = livePct >= peakPct ? Math.min(94, peakPct + 12) : Math.max(6, peakPct - 12);
    }
    const val = $("hudTiltVal");
    if (val) {
      val.textContent = (abs >= 0.5 ? String(Math.round(abs)) : "0") + "°";
      val.style.left = liveLeft + "%";
    }
    const read = $("hudTiltRead");
    if (read) {
      read.classList.toggle("warn", abs >= 10 && abs < 25);
      read.classList.toggle("hot", abs >= 25);
    }
    const pVal = $("hudTiltPeakVal");
    if (pVal) {
      pVal.textContent = returning ? String(Math.round(pAbs)) + "°" + (hudTiltPeak >= 0.5 ? " P" : hudTiltPeak <= -0.5 ? " L" : "") : "";
      pVal.classList.toggle("show", returning);
      pVal.style.left = peakPct + "%";
    }
  }
  window.nativeSetConfig = renderConfig;
  window.nativeSetStatus = updateStatus;

  // --- Integracja z Home Assistant (lokalizacja + dane BLE) ---
  const HA_SYNC_KEY = "olejarHaSync";
  let haCfg = { on: false, url: "", hook: "olejarka-trip", sec: 30, bg: "keep" };
  let haPos = null;
  let haTimer = null;

  // Trip = jeden dzien jazdy (postoje w trakcie NIE dziela tripu).
  const TRIP_HOOK = "olejarka-trip-end";
  const REFUEL_HOOK = "olejarka_refuel";
  const TRIP_HEARTBEAT_MS = 60 * 1000;
  let trip = null;
  let tripTicker = null;
  let tripHeartTimer = null;
  let tripCheckpointTimer = null;
  let connTimer = null;
  let haPinging = false;

  // Kolejka offline: punkty i trip czekaja az wroci internet.
  const HA_QUEUE_KEY = "olejarHaQueue";
  const HA_PENDING_KEY = "olejarHaPendingTrip";
  const HA_QUEUE_MAX = 600;
  const HA_FLUSH_MS = 30 * 1000;
  let haQueue = [];
  let haPending = null;
  let haFlushTimer = null;
  let dateTimer = null;
  let haFlushing = false;

  function haLoad() {
    try {
      const raw = JSON.parse(localStorage.getItem(HA_SYNC_KEY) || "null");
      if (raw && typeof raw === "object") {
        haCfg = Object.assign({}, haCfg, raw);
        if (!Number.isFinite(haCfg.sec) || haCfg.sec < 5 || haCfg.sec > 120) haCfg.sec = 30;
        if (!haCfg.hook) haCfg.hook = "olejarka-trip";
        if (haCfg.bg !== "close") haCfg.bg = "keep";
      }
    } catch (e) { /* ignore */ }
    try {
      const q = JSON.parse(localStorage.getItem(HA_QUEUE_KEY) || "[]");
      if (Array.isArray(q)) haQueue = q.slice();
    } catch (e) { /* ignore */ }
    try {
      const p = JSON.parse(localStorage.getItem(HA_PENDING_KEY) || "null");
      if (p && p.day && p.start) haPending = p;
    } catch (e) { /* ignore */ }
  }
  function haSave() {
    try { localStorage.setItem(HA_SYNC_KEY, JSON.stringify(haCfg)); } catch (e) { /* ignore */ }
  }
  function haQueueSave() {
    try { localStorage.setItem(HA_QUEUE_KEY, JSON.stringify(haQueue)); } catch (e) { /* ignore */ }
  }
  function haQueueAdd(payload, hook) {
    haQueue.push(hook ? { h: hook, b: payload } : payload);
    if (haQueue.length > HA_QUEUE_MAX) haQueue.shift();
    haQueueSave();
    haQueueNote();
  }
  function haQueueNote() {
    const el = $("haStatus");
    if (!el) return;
    if (haQueue.length > 0) {
      el.textContent = "Brak netu — w kolejce: " + haQueue.length + " pkt";
      el.className = "setting-hint warn";
    }
  }
  function haPendingSave(payload) {
    if (haPending && haPending.status === "closed" && payload.status === "open" && haPending.day === payload.day) return;
    haPending = payload;
    try { localStorage.setItem(HA_PENDING_KEY, JSON.stringify(haPending)); } catch (e) { /* ignore */ }
  }
  function haWebhookUrl() {
    return (haCfg.url || "").trim().replace(/\/+$/, "");
  }
  async function haFlush() {
    if (!haCfg.on || haFlushing) return;
    const url = haWebhookUrl();
    if (!/^https?:\/\//i.test(url)) return;
    haFlushing = true;
    try {
      if (haPending) {
        try {
          const r = await fetch(url + "/api/webhook/" + encodeURIComponent(TRIP_HOOK), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(haPending),
          });
          if (r.ok) {
            haPending = null;
            try { localStorage.removeItem(HA_PENDING_KEY); } catch (e) { /* ignore */ }
            haSetTripStatus("Trip dostarczony po powrocie zasięgu", "ok");
          }
        } catch (e) { /* zostaw */ }
      }
      let flushed = 0;
      while (haQueue.length > 0) {
        const p = haQueue[0];
        const qHook = p && p.h ? p.h : haCfg.hook;
        const qBody = p && p.h ? p.b : p;
        let ok = false;
        try {
          const r = await fetch(url + "/api/webhook/" + encodeURIComponent(qHook), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(qBody),
          });
          ok = r.ok;
        } catch (e) { ok = false; }
        if (!ok) break;
        haQueue.shift();
        flushed++;
        await new Promise((res) => setTimeout(res, 250));
      }
      if (flushed > 0) {
        haQueueSave();
        if (haQueue.length === 0) haSetStatus("Przesłano zaległe punkty (" + flushed + ")", "ok");
        else haQueueNote();
      } else if (haQueue.length > 0) {
        haQueueNote();
      }
    } finally {
      haFlushing = false;
    }
  }
  function haSetStatus(msg, cls) {
    const el = $("haStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = "setting-hint";
    if (cls) el.classList.add(cls);
  }
  function haRender() {
    const tg = $("haToggle");
    if (tg) {
      tg.textContent = haCfg.on ? "ON" : "WYŁ";
      tg.classList.toggle("on", haCfg.on);
    }
    const u = $("haUrl");
    if (u && document.activeElement !== u) u.value = haCfg.url || "";
    const h = $("haHook");
    if (h && document.activeElement !== h) h.value = haCfg.hook || "";
    const so = $("haSecOut");
    if (so) so.textContent = haCfg.sec;
  }
  let gpsFixReceived = false;
  let gpsNativeOn = false;
  let gpsIdleMs = 0;
  function haGpsStatusText(pos) {
    if (pos && pos.coords) return "GPS OK (acc " + Math.round(pos.coords.accuracy) + " m)";
    return "GPS OK";
  }
  // Pozycja z natywnego LocationManagera (fix co ~5 s podczas jazdy; na postoju wyłączony).
  // Struktura zgodna z dawnym Position, żeby reszta (tripy, ślad, alarm) działała bez zmian.
  window.nativeSetGpsFix = (fix) => {
    if (fix == null) { haPos = null; return; }
    const pos = {
      coords: {
        latitude: fix.lat,
        longitude: fix.lon,
        accuracy: fix.acc != null ? fix.acc : 0,
        speed: Number.isFinite(fix.speed) ? fix.speed : NaN,
        timestamp: fix.t || Date.now(),
      },
    };
    haPos = pos;
    tripsStorePos(pos);
    haSetStatus(haGpsStatusText(pos), "ok");
    haGpsIcon("ok");
    if (haQueue.length > 0) haFlush();
  };
  // Android zdejmuje nasłuch w onStop (ekran/klawisz zasilania, inne okno) i nie mówi
  // o tym JS — flaga gpsNativeOn zostawała „true" i fixy nie wracały. Ślad i wysyłka
  // do HA milkły do końca jazdy.
  window.nativeGpsStopped = () => {
    gpsNativeOn = false;
    haGpsIcon("warn");
  };
  function haGpsFixAgeMs(nowMs) {
    const ts = haPos && haPos.coords ? Number(haPos.coords.timestamp) || 0 : 0;
    return ts > 0 ? nowMs - ts : 1e9;
  }
  // Watchdog świeżości fixa: gdy GPS nie daje pozycji, ponawiamy nasłuch natywny
  // (gpsFixNow wymusza rejestrację) niezależnie od flagi JS.
  let gpsWatchMs = 0;
  let gpsBlindMs = 0;
  function haGpsWatch(nowMs, moving) {
    if (!haCfg.on) return;
    if (haGpsFixAgeMs(nowMs) < 15000) return;
    if (moving || trip) {
      if (nowMs - gpsWatchMs < 10000) return;
      gpsWatchMs = nowMs;
      haGpsIcon("warn");
      haSetStatus("Brak świeżego GPS — ponawiam nasłuch", "warn");
      try { bridge().gpsListen(true); bridge().gpsFixNow(); } catch (e) { /* ignore */ }
      return;
    }
    // Bez tripu i bez prędkości z BLE (olejarka wyłączona) — jeden fix na 2 min,
    // żeby wykryć start jazdy i wznowić zapis.
    if (connected) return;
    if (nowMs - gpsBlindMs < 120000) return;
    gpsBlindMs = nowMs;
    try { bridge().gpsFixNow(); } catch (e) { /* ignore */ }
  }
  function haGpsStart() {
    if (gpsNativeOn) return;
    gpsNativeOn = true;
    gpsIdleMs = 0;
    haGpsIcon("warn");
    haSetStatus("GPS włączony (jazda)", "ok");
    bridge().gpsListen(true);
  }
  function haGpsStop() {
    if (!gpsNativeOn) return;
    gpsNativeOn = false;
    haGpsIcon("warn");
    haSetStatus("Postój — GPS wyłączony", "ok");
    bridge().gpsListen(false);
  }
  // Wi-Fi (ESPHome): odbiorca wpisuje swoją sieć, dane idą do olejarki przez BLE
  // i zapisują się w niej na stałe — po podłączeniu olejarka pojawia się w jego ESPHome.
  const WIFI_KEY = "olejarWifi";
  let wifiLast = null;   // { ssid, at, hasPass, ok }
  function wifiLoad() {
    try {
      const v = JSON.parse(localStorage.getItem(WIFI_KEY) || "null");
      if (v && typeof v.ssid === "string") {
        wifiLast = { ssid: v.ssid, at: Number(v.at) || 0, hasPass: !!v.hasPass, ok: v.ok !== false };
      }
    } catch (e) { /* ignore */ }
    wifiRender();
  }
  function wifiRender() {
    const el = $("wifiStatus");
    if (!el) return;
    if (!wifiLast || !wifiLast.ssid) {
      el.textContent = "Nie wysłano jeszcze żadnej sieci.";
      return;
    }
    el.textContent = "Ostatnio wysłane: " + wifiLast.ssid +
      " · hasło: " + (wifiLast.hasPass ? "••••" : "brak") +
      " · " + (wifiLast.at > 0 ? fmtStamp(wifiLast.at) : "—") +
      (wifiLast.ok ? "" : " · bez połączenia — nie dotarło");
  }
  function wifiSetup() {
    const prefill = wifiLast && wifiLast.ssid ? wifiLast.ssid : "";
    askInput("Nazwa sieci Wi-Fi (SSID)", "np. Moja siec", "textno", prefill,
      { title: "Wi-Fi", kicker: "ESPHome", ok: "DALEJ" }).then((ssid) => {
      if (ssid == null) return;
      ssid = String(ssid).trim();
      if (!ssid) { nativeNotifyAlert("Wi-Fi", "Nie wpisano nazwy sieci."); return; }
      askInput("Hasło do sieci Wi-Fi", "", "textno", "",
        { title: "Wi-Fi", kicker: "ESPHome", ok: "PODŁĄCZ" }).then((pass) => {
        if (pass == null) return;
        pass = String(pass);
        const linked = connected;
        command("WIFI_SSID " + ssid);
        command("WIFI_PASS " + pass);
        command("WIFI_CONNECT");
        wifiLast = { ssid: ssid, at: Date.now(), hasPass: pass.length > 0, ok: linked };
        try { localStorage.setItem(WIFI_KEY, JSON.stringify(wifiLast)); } catch (e) { /* ignore */ }
        wifiRender();
        nativeNotifyAlert("Wi-Fi", "Wysłano do olejarki: \"" + ssid + "\"" +
          (linked ? "" : " (bez połączenia — dane nie dotarły; połącz się i wyślij ponownie)") +
          ". Po chwili przełączy się na tę sieć i pojawi się w Twoim ESPHome (Adopt). " +
          "Możesz w każdej chwili wysłać inną sieć — nowa zastąpi poprzednią.", true);
      });
    });
  }

  function haStart() {
    haStopTimers();
    sendDateNow();
    if (dateTimer) clearInterval(dateTimer);
    dateTimer = setInterval(() => sendDateNow(), 15 * 60 * 1000);
    haHaIcon("warn");
    // Natywny GPS: świeży fix na start (ostatnia znana pozycja) + nasłuch co ~5 s na jeździe.
    gpsFixReceived = false;
    gpsNativeOn = false;
    haGpsIcon("warn");
    bridge().gpsFixNow();
    if (haTimer) clearInterval(haTimer);
    haTimer = setInterval(haSend, haCfg.sec * 1000);
    if (tripTicker) clearInterval(tripTicker);
    tripTicker = setInterval(haTripTick, 1000);
    if (tripHeartTimer) clearInterval(tripHeartTimer);
    tripHeartTimer = setInterval(haTripHeart, TRIP_HEARTBEAT_MS);
    if (connTimer) clearInterval(connTimer);
    connTimer = setInterval(haPing, 300 * 1000);
    if (haFlushTimer) clearInterval(haFlushTimer);
    haFlushTimer = setInterval(haFlush, HA_FLUSH_MS);
    haSetStatus("Aktywne — czekam na GPS", "ok");
    haPing();
    haSend();
  }
  function haStopTimers() {
    if (haTimer) { clearInterval(haTimer); haTimer = null; }
    if (tripTicker) { clearInterval(tripTicker); tripTicker = null; }
    if (tripHeartTimer) { clearInterval(tripHeartTimer); tripHeartTimer = null; }
    if (connTimer) { clearInterval(connTimer); connTimer = null; }
    if (haFlushTimer) { clearInterval(haFlushTimer); haFlushTimer = null; }
    if (dateTimer) { clearInterval(dateTimer); dateTimer = null; }
    gpsFixReceived = false;
    haPinging = false;
    haFlushing = false;
    gpsIdleMs = 0;
  }
  function haStop() {
    haStopTimers();
    if (gpsNativeOn) { gpsNativeOn = false; bridge().gpsListen(false); }
    if (trip) haTripSend("closed");
    haPos = null;
    haSetStatus("Wyłączone");
    haSetConn("Wyłączone");
    haGpsIcon(null);
    haHaIcon(null);
  }
  function haSendParking() {
    const pos = haPos;
    if (!pos || !pos.coords) return;
    const coords = pos.coords;
    haQueueAdd({
      lat: Math.round(coords.latitude * 1e6) / 1e6,
      lon: Math.round(coords.longitude * 1e6) / 1e6,
      acc: Math.round(coords.accuracy || 0),
      spd: 0,
      park: 1,
    });
  }
  function haOnBleLost() {
    if (!haCfg.on || !trip) return;
    haSendParking();
    haFlush();
  }
  function haOnBleResume() {
    sendDateNow();
  }
  function haGpsIcon(cls) {
    const el = $("gpsSig");
    if (!el) return;
    if (!cls) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle("ok", cls === "ok");
    el.classList.toggle("warn", cls === "warn");
    el.classList.toggle("err", cls === "err");
  }
  function haHaIcon(cls) {
    const el = $("haSig");
    if (!el) return;
    if (!cls) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle("ok", cls === "ok");
    el.classList.toggle("warn", cls === "warn");
    el.classList.toggle("err", cls === "err");
  }
  function haOnAppHide() {
    if (!haCfg.on) return;
    haSendParking();
    haFlush();
  }
  function haRequestExit() {
    if (!haCfg.on) { haFlush(); return; }
    haSendParking();
    haTripCheckpoint();
    haStopTimers();
    haSetStatus("Wysyłam ostatnie dane…");
    haFlush();
  }
  function nativeExitAsk() {
    askConfirm(
      "Ostatnia lokalizacja zostanie wysłana do Home Assistant. Trip pozostaje otwarty i wróci po ponownym uruchomieniu — zamknie się po północy.",
      true,
      "ZAMKNIJ",
      "Zamknąć apkę?"
    ).then((ok) => {
      if (!ok) return;
      haRequestExit();
      const b = bridge();
      if (b && b.finishApp) b.finishApp();
    });
  }

  function tripsSaveDay(day, t) {
    const mkEntry = (path) => ({
      start: fmtIso(new Date(t.startMs)),
      end: fmtIso(new Date(t.endMs)),
      dist_km: Math.round(t.dist * 100) / 100,
      moving_min: Math.round((t.movingSec / 60) * 10) / 10,
      avg_kmh: t.movingSec > 0 ? Math.round(t.dist / (t.movingSec / 3600)) : 0,
      max_kmh: Math.round(t.max),
      max_tilt: Math.round(t.maxTiltAbs || 0),
      max_rpm: Math.round(t.maxRpm || 0),
      max_load: Math.round(t.maxLoad || 0),
      max_throttle: Math.round(t.maxThrottle || 0),
      path: path,
    });
    const trySave = (entry) => {
      const all = JSON.parse(localStorage.getItem(TRIPS_KEY) || "null") || {};
      if (!all[day]) all[day] = [];
      else if (!Array.isArray(all[day])) all[day] = [all[day]];
      all[day].push(entry);
      if (all[day].length > 20) all[day].splice(0, all[day].length - 20);
      const days = Object.keys(all).sort();
      while (days.length > TRIPS_MAX_DAYS) delete all[days.shift()];
      localStorage.setItem(TRIPS_KEY, JSON.stringify(all));
    };
    const path = t.path || [];
    try { trySave(mkEntry(path)); return; } catch (e) {}
    const ds2 = path.filter((_, i) => i % 2 === 0);
    try { trySave(mkEntry(ds2)); return; } catch (e) {}
    const ds4 = path.filter((_, i) => i % 4 === 0);
    try { trySave(mkEntry(ds4)); return; } catch (e) {}
    try { trySave(mkEntry([])); } catch (e) {}
  }

  function tripsData() {
    try { return JSON.parse(localStorage.getItem(TRIPS_KEY) || "null") || {}; } catch (e) { return {}; }
  }

  function tripsDayTrips(day) {
    const raw = tripsData()[day];
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter((t) => t && (t.path || t.dist_km));
    if (raw.path || raw.dist_km) return [raw];
    return [];
  }

  let tripMap = null;
  let tripL = null;
  let tripEngine = "none";
  let tripUserMoved = false;
  let tripLiveTimer = null;
  let tripSelectedIdx = null;
  let tripFocusLoc = false;
  let tripFocusLock = false;
  let tripsFallbackTimer = null;
  let tripLRouteCase = null;
  let tripLRoute = null;
  let tripLLive = null;
  let tripLStart = null;
  let tripLEnd = null;
  let tripLDot = null;
  let tripLSpeed = null;
  let tripLSpeedSig = "";

  const SPEED_STOPS = [
    { max: 30, color: "#3B82F6" },
    { max: 60, color: "#23A55A" },
    { max: 90, color: "#d29922" },
    { max: 120, color: "#f0883e" },
    { max: 1e9, color: "#f47067" },
  ];

  function speedColorOf(spd) {
    if (!Number.isFinite(spd) || spd <= 0) return null;
    for (const s of SPEED_STOPS) if (spd < s.max) return s.color;
    return "#f47067";
  }

  function tripsColPrefix(r) {
    if (r.live) return null;
    const has = (r.pts || []).some((p) => Number.isFinite(p.spd) && p.spd > 0);
    return has ? "route-v" : null;
  }

  function routeRuns(pts) {
    const runs = [];
    let cur = null;
    const flush = () => { if (cur && cur.coords.length >= 2) runs.push(cur); cur = null; };
    for (const p of pts) {
      const color = speedColorOf(p.spd);
      if (cur && cur.color === color) {
        cur.coords.push([p.lon, p.lat]);
      } else {
        flush();
        cur = { color, coords: [[p.lon, p.lat]] };
      }
    }
    flush();
    return runs;
  }

  function tripsWebglOk() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (e) { return false; }
  }

  function tripsResize() {
    if (tripMap) { try { tripMap.resize(); } catch (e) {} }
    else if (tripL) { try { tripL.invalidateSize(); } catch (e) {} }
  }

  // ------------------------------------------------ cache kafelków (leaflet)
  const TILE_CACHE_DB = "olejarTileCache";
  const TILE_CACHE_STORE = "tiles";
  const TILE_PH = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgGAAAAAMAAMvDN8oAAAAASUVORK5CYII=";

  function tileDbOpen() {
    return new Promise((resolve, reject) => {
      try {
        const rq = indexedDB.open(TILE_CACHE_DB, 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore(TILE_CACHE_STORE);
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      } catch (e) { reject(e); }
    });
  }

  async function tileGet(key) {
    try {
      const db = await tileDbOpen();
      return await new Promise((resolve) => {
        const rq = db.transaction(TILE_CACHE_STORE, "readonly").objectStore(TILE_CACHE_STORE).get(key);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }

  async function tilePut(key, blob) {
    try {
      const db = await tileDbOpen();
      await new Promise((resolve) => {
        const tx = db.transaction(TILE_CACHE_STORE, "readwrite");
        tx.objectStore(TILE_CACHE_STORE).put(blob, key);
        tx.oncomplete = resolve;
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
      mapCacheCount++;
      updateMapCacheUi();
    } catch (e) { /* ignore */ }
  }

  async function tileClear() {
    try {
      const db = await tileDbOpen();
      await new Promise((resolve) => {
        const tx = db.transaction(TILE_CACHE_STORE, "readwrite");
        tx.objectStore(TILE_CACHE_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
      mapCacheCount = 0;
      updateMapCacheUi();
    } catch (e) { /* ignore */ }
  }

  async function tileCount() {
    try {
      const db = await tileDbOpen();
      db.transaction(TILE_CACHE_STORE, "readonly").objectStore(TILE_CACHE_STORE).count().onsuccess = (e) => {
        mapCacheCount = e.target.result || 0;
        updateMapCacheUi();
      };
    } catch (e) { /* ignore */ }
  }

  const tripsTileLayer = L.GridLayer.extend({
    createTile: function (coords, done) {
      const key = coords.z + "/" + coords.x + "/" + coords.y;
      const url = "https://tile.openstreetmap.org/" + key + ".png";
      const img = L.DomUtil.create("img");
      img.alt = "";
      let settled = false;
      const finish = () => { if (!settled) { settled = true; done(null); } };
      img.onload = () => finish();
      img.onerror = () => { img.src = TILE_PH; finish(); };
      (async () => {
        const blob = await tileGet(key);
        if (blob) { img.src = URL.createObjectURL(blob); return; }
        if (mapOffline) { img.src = TILE_PH; return; }
        try {
          const resp = await fetch(url, { credentials: "omit" });
          if (!resp.ok) { img.src = TILE_PH; return; }
          const tBlob = await resp.blob();
          if (tBlob && tBlob.size > 0) {
            tilePut(key, tBlob);
            img.src = URL.createObjectURL(tBlob);
          } else {
            img.src = TILE_PH;
          }
        } catch (e) { img.src = TILE_PH; }
      })();
      return img;
    },
  });

  function tripsInitMap() {
    if (tripMap || tripL || tripEngine === "leaflet") return;
    const el = $("tripMap");
    if (!el) return;
    if (mapOffline) { tripsInitLeaflet(); return; }
    if (typeof maplibregl === "undefined" || !tripsWebglOk()) { tripsInitLeaflet(); return; }
    try {
      tripMap = new maplibregl.Map({
        container: el,
        style: {
          version: 8,
          name: "osm",
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [{ id: "osm", type: "raster", source: "osm" }],
        },
        center: [23.1, 52.15],
        zoom: 12,
        attributionControl: false,
        preserveDrawingBuffer: true,
      });
    } catch (e) {
      tripMap = null;
      tripsInitLeaflet();
      return;
    }
    tripEngine = "maplibre";
    tripMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    tripMap.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    tripMap.on("dragstart zoomstart", () => { tripUserMoved = true; });
    tripMap.on("load", () => { tripsInitLayers(); tripsDraw(); });
    tripMap.on("error", () => { if (tripMap && !tripMap.isStyleLoaded()) tripsLFallback(); });
    clearTimeout(tripsFallbackTimer);
    tripsFallbackTimer = setTimeout(() => {
      if (tripMap && !tripMap.isStyleLoaded()) tripsLFallback();
    }, 12000);
  }

  function tripsInitLeaflet() {
    if (tripL || tripEngine === "leaflet") return;
    const el = $("tripMap");
    if (!el || typeof L === "undefined") return;
    tripEngine = "leaflet";
    try {
      tripL = L.map(el, { zoomControl: false, attributionControl: false, center: [52.15, 23.1], zoom: 12 });
      new tripsTileLayer({ maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(tripL);
      L.control.zoom({ position: "topright" }).addTo(tripL);
      L.control.attribution({ position: "bottomright", prefix: false }).addTo(tripL);
      tripL.on("dragstart zoomstart zoomend", () => { tripUserMoved = true; });
      tripsInitLeafletLayers();
      setTimeout(tripsResize, 60);
      tripsDraw();
    } catch (e) {
      tripL = null;
      tripEngine = "none";
    }
  }

  function tripsLFallback() {
    if (tripL || !$("tripMap")) return;
    if (tripMap) { try { tripMap.remove(); } catch (e) {} tripMap = null; tripEngine = "none"; }
    tripsInitLeaflet();
  }

  function tripsRecycle() {
    if (tripMap) { try { tripMap.remove(); } catch (e) {} }
    if (tripL) { try { tripL.remove(); } catch (e) {} }
    tripMap = null;
    tripL = null;
    tripEngine = "none";
    tripLRouteCase = tripLRoute = tripLLive = tripLStart = tripLEnd = tripLDot = tripLSpeed = null;
    tripLSpeedSig = "";
    tripsInitMap();
    tripsDraw();
  }

  function tripsInitLeafletLayers() {
    if (!tripL) return;
    if (!tripLRouteCase) tripLRouteCase = L.polyline([], { color: "#0E1117", weight: 8, opacity: .7, lineJoin: "round", lineCap: "round" }).addTo(tripL);
    if (!tripLRoute) tripLRoute = L.polyline([], { color: "#3FB950", weight: 4, opacity: .95, lineJoin: "round", lineCap: "round" }).addTo(tripL);
    if (!tripLLive) tripLLive = L.polyline([], { color: "#3B82F6", weight: 5, opacity: .95, dashArray: "1.5 1", lineJoin: "round", lineCap: "round" }).addTo(tripL);
    if (!tripLStart) tripLStart = L.circleMarker([0, 0], { radius: 9, color: "#0E1117", weight: 2, fillColor: "#3B82F6", fillOpacity: 1 }).addTo(tripL);
    if (!tripLEnd) tripLEnd = L.circleMarker([0, 0], { radius: 9, color: "#0E1117", weight: 2, fillColor: "#F85149", fillOpacity: 1 }).addTo(tripL);
    if (!tripLDot) tripLDot = L.circleMarker([0, 0], { radius: 8, color: "#FFFFFF", weight: 2, fillColor: "#3B82F6", fillOpacity: 1 }).addTo(tripL);
  }

  function tripsInitLayers() {
    if (!tripMap || !tripMap.isStyleLoaded() || tripMap.getSource("trips-routes")) return;
    const emptyFC = { type: "FeatureCollection", features: [] };
    tripMap.addSource("trips-routes", { type: "geojson", data: emptyFC });
    tripMap.addSource("trips-dot", { type: "geojson", data: emptyFC });
    tripMap.addLayer({
      id: "trips-route-case",
      type: "line",
      source: "trips-routes",
      filter: ["in", "kind", "route", "live", "route-v", "live-v"],
      paint: { "line-color": "#0E1117", "line-width": 8, "line-opacity": .7, "line-cap": "round", "line-join": "round" },
    });
    tripMap.addLayer({
      id: "trips-route",
      type: "line",
      source: "trips-routes",
      filter: ["==", "kind", "route"],
      paint: { "line-color": "#3FB950", "line-width": 4, "line-opacity": .95, "line-cap": "round", "line-join": "round" },
    });
    tripMap.addLayer({
      id: "trips-speed",
      type: "line",
      source: "trips-routes",
      filter: ["in", "kind", "route-v", "live-v"],
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": .95, "line-cap": "round", "line-join": "round" },
    });
    tripMap.addLayer({
      id: "trips-live",
      type: "line",
      source: "trips-routes",
      filter: ["==", "kind", "live"],
      paint: { "line-color": "#3B82F6", "line-width": 5, "line-dasharray": [1.5, 1], "line-opacity": .95, "line-cap": "round", "line-join": "round" },
    });
    tripMap.addLayer({
      id: "trips-start",
      type: "circle",
      source: "trips-routes",
      filter: ["==", "kind", "start"],
      paint: { "circle-radius": 9, "circle-color": "#3B82F6", "circle-stroke-color": "#0E1117", "circle-stroke-width": 2 },
    });
    tripMap.addLayer({
      id: "trips-end",
      type: "circle",
      source: "trips-routes",
      filter: ["==", "kind", "end"],
      paint: { "circle-radius": 9, "circle-color": "#F85149", "circle-stroke-color": "#0E1117", "circle-stroke-width": 2 },
    });
    tripMap.addLayer({
      id: "trips-dot-halo",
      type: "circle",
      source: "trips-dot",
      paint: { "circle-radius": 20, "circle-color": "rgba(59,130,246,0.25)", "circle-stroke-color": "rgba(59,130,246,0.4)", "circle-stroke-width": 1 },
    });
    tripMap.addLayer({
      id: "trips-dot",
      type: "circle",
      source: "trips-dot",
      paint: { "circle-radius": 8, "circle-color": "#3B82F6", "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 2 },
    });
  }

  function tripsClearRoute() {
    if (tripMap) {
      const src = tripMap.getSource("trips-routes");
      if (src && typeof src.setData === "function") src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    if (tripL) {
      if (tripLRouteCase) tripLRouteCase.setLatLngs([]);
      if (tripLRoute) tripLRoute.setLatLngs([]);
      if (tripLLive) tripLLive.setLatLngs([]);
      if (tripLSpeed) { tripL.removeLayer(tripLSpeed); tripLSpeed = null; }
      if (tripLStart) tripLStart.setLatLng([0, 0]);
      if (tripLEnd) tripLEnd.setLatLng([0, 0]);
    }
  }

  function tripsBestPos() {
    if (haPos && haPos.coords && Number.isFinite(haPos.coords.longitude) && Number.isFinite(haPos.coords.latitude)) {
      return haPos.coords;
    }
    try {
      const raw = JSON.parse(localStorage.getItem("olejarLastPosV1") || "null");
      if (raw && Number.isFinite(raw.latitude) && Number.isFinite(raw.longitude)) return raw;
    } catch (e) { /* ignore */ }
    return null;
  }

  function tripsStorePos(pos) {
    if (!pos || !pos.coords) return;
    try {
      localStorage.setItem("olejarLastPosV1", JSON.stringify({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy || 0,
        ts: Date.now(),
      }));
    } catch (e) { /* ignore */ }
  }

  function tripsSetDot() {
    const pos = tripsBestPos();
    if (tripMap) {
      const src = tripMap.getSource("trips-dot");
      if (!src || typeof src.setData !== "function") return;
      src.setData({
        type: "FeatureCollection",
        features: pos ? [{ type: "Feature", geometry: { type: "Point", coordinates: [pos.longitude, pos.latitude] }, properties: {} }] : [],
      });
      return;
    }
    if (tripL) {
      if (!tripLDot) return;
      if (pos) tripLDot.setLatLng([pos.latitude, pos.longitude]);
      else tripLDot.setLatLng([0, 0]);
    }
  }

  let tripsFallbackLastMs = 0;
  function tripsDotFallback() {
    if (tripsBestPos()) return;
    if (!("geolocation" in navigator)) return;
    const nowMs = Date.now();
    if (nowMs - tripsFallbackLastMs < 15000) return;
    tripsFallbackLastMs = nowMs;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        haPos = pos;
        tripsStorePos(pos);
        tripsSetDot();
        tripsDraw();
      },
      () => { /* ignore */ },
      { enableHighAccuracy: true, maximumAge: 20000, timeout: 8000 }
    );
  }

  function tripsRefresh() {
    tripUserMoved = false;
    const all = tripsData();
    const hint = $("tripsCountHint");
    if (hint) {
      const days = Object.keys(all).filter((d) => tripsDayTrips(d).some((r) => (r.path || []).length > 0));
      hint.textContent = days.length ? "Zapisano " + days.length + "/" + TRIPS_MAX_DAYS + " dni tras na tym telefonie." : "Brak tripów na tym telefonie.";
    }
    tripsDraw();
  }

  function tripsDisplayTrip(day, idx) {
    const allRows = tripsDayTrips(day).map((r) => ({
      km: Number(r.dist_km) || 0,
      min: Number(r.moving_min) || 0,
      max: Number(r.max_kmh) || 0,
      tilt: Number(r.max_tilt) || 0,
      rpm: Number(r.max_rpm) || 0,
      load: Number(r.max_load) || 0,
      thr: Number(r.max_throttle) || 0,
      st: r.start || null,
      en: r.end || null,
      pts: (r.path || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
    })).filter((r) => r.pts.length >= 2);
    if (day === dayNow() && trip && trip.day === day) {
      const livePts = (trip.path || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (livePts.length >= 2) {
        allRows.push({
          live: true,
          km: Number(trip.dist) || 0,
          min: (trip.movingSec || 0) / 60,
          max: Number(trip.max) || 0,
          tilt: Number(trip.maxTiltAbs) || 0,
          rpm: Number(trip.maxRpm) || 0,
          load: Number(trip.maxLoad) || 0,
          thr: Number(trip.maxThrottle) || 0,
          st: fmtIso(new Date(trip.startMs)),
          en: fmtIso(new Date(trip.endMs)),
          pts: livePts,
        });
      }
    }
    let rows = allRows;
    if (idx != null && idx >= 0 && idx < allRows.length) rows = [allRows[idx]];
    let start = null, end = null;
    if (rows.length) {
      start = rows[0].pts[0];
      end = rows[rows.length - 1].pts[rows[rows.length - 1].pts.length - 1];
    }
    return { rows, start, end, allRows };
  }

  function tripsRender(disp) {
    if (tripMap) {
      tripsInitLayers();
      if (!tripMap.isStyleLoaded()) return;
      const src = tripMap.getSource("trips-routes");
      if (!src || typeof src.setData !== "function") return;
      const features = [];
      const bounds = [];
      disp.rows.forEach((r) => {
        const colored = tripsColPrefix(r);
        if (colored) {
          for (const run of routeRuns(r.pts)) {
            features.push({ type: "Feature", geometry: { type: "LineString", coordinates: run.coords }, properties: { kind: colored, color: run.color } });
          }
        } else {
          const coords = r.pts.map((p) => [p.lon, p.lat]);
          features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { kind: r.live ? "live" : "route" } });
        }
        if (r.pts.length) {
          bounds.push([r.pts[0].lon, r.pts[0].lat]);
          bounds.push([r.pts[r.pts.length - 1].lon, r.pts[r.pts.length - 1].lat]);
        }
      });
      if (disp.start) features.push({ type: "Feature", geometry: { type: "Point", coordinates: [disp.start.lon, disp.start.lat] }, properties: { kind: "start" } });
      if (disp.end) features.push({ type: "Feature", geometry: { type: "Point", coordinates: [disp.end.lon, disp.end.lat] }, properties: { kind: "end" } });
      src.setData({ type: "FeatureCollection", features });
      tripsSetDot();
      if (!tripUserMoved && !tripFocusLock && bounds.length) {
        tripMap.fitBounds(bounds, { padding: 44, maxZoom: 16 });
      }
      return;
    }
    if (tripL) {
      tripsInitLeafletLayers();
      const routeLL = [];
      const liveLL = [];
      const gpsLL = [];
      disp.rows.forEach((r) => {
        const colored = tripsColPrefix(r);
        const ll = r.pts.map((p) => [p.lat, p.lon]);
        if (!colored) (r.live ? liveLL : routeLL).push(ll);
        ll.forEach((x) => gpsLL.push(x));
      });
      if (tripLRouteCase) tripLRouteCase.setLatLngs(routeLL);
      if (tripLRoute) tripLRoute.setLatLngs(routeLL);
      if (tripLLive) tripLLive.setLatLngs(liveLL);
      const sig = disp.rows.map((r) => (tripsColPrefix(r) ? "v" : r.live ? "l" : "r") + "_" + ((r.pts || []).length)).join(",");
      if (sig !== tripLSpeedSig || !tripLSpeed) {
        tripLSpeedSig = sig;
        if (tripLSpeed) { tripL.removeLayer(tripLSpeed); tripLSpeed = null; }
        tripLSpeed = L.layerGroup().addTo(tripL);
        disp.rows.forEach((r) => {
          if (!tripsColPrefix(r)) return;
          for (const run of routeRuns(r.pts)) {
            const ll = run.coords.map((c) => [c[1], c[0]]);
            L.polyline(ll, { color: run.color, weight: 4, opacity: .95, lineJoin: "round", lineCap: "round" }).addTo(tripLSpeed);
          }
        });
      }
      if (tripLStart) tripLStart.setLatLng(disp.start ? [disp.start.lat, disp.start.lon] : [0, 0]);
      if (tripLEnd) tripLEnd.setLatLng(disp.end ? [disp.end.lat, disp.end.lon] : [0, 0]);
      tripsSetDot();
      if (!tripUserMoved && !tripFocusLock && gpsLL.length) {
        tripL.fitBounds(gpsLL, { padding: [44, 44], maxZoom: 16 });
      }
    }
  }

  function tripsStatValues(rows) {
    const s = { km: 0, min: 0, max: 0, tilt: 0, rpm: 0, load: 0, thr: 0, avg: 0, startT: null, endT: null, live: false };
    rows.forEach((r) => {
      s.km += Number(r.km) || 0;
      s.min += Number(r.min) || 0;
      if (Number(r.max) > s.max) s.max = Number(r.max);
      if (Number(r.tilt) > s.tilt) s.tilt = Number(r.tilt);
      if (Number(r.rpm) > s.rpm) s.rpm = Number(r.rpm);
      if (Number(r.load) > s.load) s.load = Number(r.load);
      if (Number(r.thr) > s.thr) s.thr = Number(r.thr);
      if (!s.startT && r.st) s.startT = r.st;
      if (r.en) s.endT = r.en;
      if (r.live) s.live = true;
    });
    s.avg = s.min > 0 ? s.km / (s.min / 60) : 0;
    return s;
  }

  function tripsFillPanel(v, rows) {
    const set = (id, num, unit) => {
      const el = $(id);
      if (el) el.textContent = (typeof num === "number" && num > 0) ? Math.round(num) + unit : "0";
    };
    set("sbKm", v.km, " km");
    set("sbMax", v.max, " km/h");
    set("sbMin", v.min, " min");
    set("sbTilt", v.tilt, "°");
    const ev = state || {};
    const zd = Number.isFinite(ev.zd) ? Math.round(ev.zd) : null;
    const el = $("sbOil");
    if (el) el.textContent = zd == null ? "–" : zd + " ml";
  }

  function tripsDraw() {
    const input = $("tripDate");
    const empty = $("tripsEmpty");
    const label = $("tripDayLabel");
    const day = input ? input.value : "";
    if (!day) return;
    tripsInitMap();
    if (!tripMap && !tripL) {
      if (empty) { empty.textContent = "Brak biblioteki mapy (WebGL) — zaktualizuj apkę."; empty.hidden = false; }
      if (label) label.hidden = true;
      return;
    }
    const parts = day.split("-");
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayN = Math.round((today.getTime() - d.getTime()) / 86400000);
    if (label) {
      label.textContent = dayN === 0 ? "Dziś" : d.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "numeric" });
      label.hidden = false;
    }
    const allDisp = tripsDisplayTrip(day);
    const timeGroup = $("tripTimeGroup");
    const timeSelect = $("tripTimeSelect");
    if (timeSelect) {
      timeSelect.innerHTML = "";
      if (allDisp.allRows && allDisp.allRows.length > 1) {
        allDisp.allRows.forEach((r, i) => {
          const opt = document.createElement("option");
          opt.value = i;
          const t = r.st ? r.st.split("T")[1].slice(0, 5) : "—";
          opt.textContent = t + "  •  " + (r.km || 0).toFixed(1) + " km";
          timeSelect.appendChild(opt);
        });
        if (tripSelectedIdx != null && tripSelectedIdx >= 0 && tripSelectedIdx < allDisp.allRows.length) {
          timeSelect.value = tripSelectedIdx;
        } else {
          tripSelectedIdx = null;
        }
        if (timeGroup) timeGroup.hidden = false;
      } else {
        if (timeGroup) timeGroup.hidden = true;
        tripSelectedIdx = null;
      }
    }
    const disp = tripsDisplayTrip(day, tripSelectedIdx);
    const v = tripsStatValues(disp.rows);
    tripsFillPanel(v, disp.rows);
    const pos = tripsBestPos();
    const focused = tripFocusLoc && pos && !tripUserMoved;
    if (focused) {
      if (tripMap) tripMap.jumpTo({ center: [pos.longitude, pos.latitude], zoom: 14 });
      else if (tripL) tripL.setView([pos.latitude, pos.longitude], 14);
    }
    tripFocusLock = !!focused;
    if (!tripMap || tripMap.isStyleLoaded() || tripL) tripFocusLoc = false;
    if (!disp.rows.length) {
      tripsRender({ rows: [], start: null, end: null });
      if (pos && !tripUserMoved) {
        if (tripMap) tripMap.jumpTo({ center: [pos.longitude, pos.latitude], zoom: 14 });
        else if (tripL) tripL.setView([pos.latitude, pos.longitude], 14);
      }
      if (empty) {
        empty.hidden = !!pos;
        empty.textContent = pos ? "" : "Brak tripów tego dnia — czekam na lokalizację…";
      }
      tripFocusLock = false;
      return;
    }
    if (empty) empty.hidden = true;
    tripsRender(disp);
    tripFocusLock = false;
  }

  function tripsSetupDate() {
    const input = $("tripDate");
    if (!input) return;
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const minD = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (TRIPS_MAX_DAYS - 1));
    input.min = minD.getFullYear() + "-" + pad(minD.getMonth() + 1) + "-" + pad(minD.getDate());
    input.max = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
    input.value = input.max;
    input.addEventListener("change", () => { tripSelectedIdx = null; tripsDraw(); });
    const timeSelect = $("tripTimeSelect");
    if (timeSelect) timeSelect.addEventListener("change", () => { tripSelectedIdx = parseInt(timeSelect.value, 10) || null; tripsDraw(); });
  }

  function showTrips() {
    lockOnLeave();
    tripUserMoved = false;
    tripFocusLoc = true;
    document.body.classList.add("trips");
    document.body.classList.remove("settings", "charts", "profiles", "errors", "info", "pulpit");
    $("hudBtn").classList.remove("on");
    tripsRefresh();
    tripsDotFallback();
    setTimeout(tripsResize, 60);
    setTimeout(tripsResize, 250);
    pushView("trips");
  }

  function showInfo() {
    document.body.classList.add("info");
    document.body.classList.remove("settings", "charts", "profiles", "errors", "trips", "pulpit");
    $("hudBtn").classList.remove("on");
    pushView("info");
  }

  function tripsInit() {
    const open = $("tripsOpenBtn");
    if (open) open.onclick = showTrips;
    const hb = $("tripsHudBtn");
    if (hb) hb.onclick = showHud;
    tripsSetupDate();
    window.addEventListener("resize", tripsResize);
    tripLiveTimer = setInterval(() => {
      if (document.body.classList.contains("trips")) {
        tripsDraw();
        tripsDotFallback();
      }
    }, 5000);
  }

  function haApply() {
    haCfg.url = ($("haUrl").value || "").trim();
    haCfg.hook = ($("haHook").value || "").trim() || "olejarka-trip";
    haSave();
    if (haCfg.on) haStart();
    haRender();
  }
  function haSend() {
    if (!haCfg.on) return;
    const url = haWebhookUrl();
    if (!/^https?:\/\//i.test(url)) { haSetStatus("Wpisz adres HA", "err"); return; }
    const pos = haPos;
    if (!pos || !pos.coords) return;
    if (haGpsFixAgeMs(Date.now()) > 60000) return;   // nie wysyłaj zamrożonej pozycji
    const ev = state || {};
    const bleSpd = Number.isFinite(ev.speed) ? ev.speed : NaN;
    const gpsSpd = Number.isFinite(pos.coords.speed) ? pos.coords.speed * 3.6 : NaN;
    const spdKph = Number.isFinite(bleSpd) && bleSpd > 0 ? bleSpd : (Number.isFinite(gpsSpd) ? gpsSpd : 0);
    if (spdKph < 5) return;
    const payload = {
      lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
      lon: Math.round(pos.coords.longitude * 1e6) / 1e6,
      acc: Math.round(pos.coords.accuracy || 0),
      spd: Math.round(spdKph),
      hdg: Math.round(pos.coords.heading || 0),
    };
    if (Number.isFinite(ev.fuelTotal)) payload.fuel = Math.round(ev.fuelTotal * 100) / 100;
    if (Number.isFinite(ev.obdCoolant)) payload.tmp = Math.round(ev.obdCoolant);
    const dayMaxTilt = pulpitTodayMax("tilt");
    if (dayMaxTilt != null && dayMaxTilt > 0) payload.tilt = Math.round(dayMaxTilt * 10) / 10;
    if (Number.isFinite(ev.rpm)) payload.rpm = Math.round(ev.rpm);
    if (Number.isFinite(ev.load)) payload.load = Math.round(ev.load);
    if (Number.isFinite(ev.throttle)) payload.throttle = Math.round(ev.throttle);
    if (Number.isFinite(ev.poz)) payload.oil = Math.round(ev.poz);
    if (Number.isFinite(ev.obdFuel)) payload.fuelh = Math.round(ev.obdFuel * 10) / 10;
    fetch(url + "/api/webhook/" + encodeURIComponent(haCfg.hook), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => {
        if (r.ok) haSetStatus("Wysłano " + new Date().toLocaleTimeString(), "ok");
        else {
          haQueueAdd(payload);
          haSetStatus("HTTP " + r.status + " — do kolejki", "err");
        }
      })
      .catch(() => {
        haQueueAdd(payload);
        haQueueNote();
      });
  }

  function dayNow() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtIso(dt) {
    const p = (n) => String(n).padStart(2, "0");
    return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + "T" +
      p(dt.getHours()) + ":" + p(dt.getMinutes()) + ":" + p(dt.getSeconds());
  }
  function haGpsDistKm(a, b) {
    const R = 6371;
    const toR = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * toR;
    const dLon = (b.longitude - a.longitude) * toR;
    const la1 = a.latitude * toR;
    const la2 = b.latitude * toR;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function haTripStart(nowMs) {
    trip = {
      day: dayNow(),
      startMs: nowMs,
      endMs: nowMs,
      lastMoveMs: nowMs,
      dist: 0,
      max: 0,
      maxTiltAbs: 0,
      maxRpm: 0,
      maxLoad: 0,
      maxThrottle: 0,
      movingSec: 0,
      lastFix: haPos && haPos.coords ? haPos.coords : null,
      path: [],
    };
    haTripCheckpointStart();
  }
  function haTripTick() {
    if (!haCfg.on) return;
    const nowMs = Date.now();
    const day = dayNow();
    if (trip && trip.day !== day) {
      haTripSend("closed");
    }
    const ev = state || {};
    const bleSpd = Number.isFinite(ev.speed) ? ev.speed : NaN;
    const gpss = haPos && Number.isFinite(haPos.coords.speed) ? haPos.coords.speed * 3.6 : NaN;
    const spd = Number.isFinite(bleSpd) && bleSpd > 0 ? bleSpd : (Number.isFinite(gpss) ? gpss : 0);
    const moving = spd >= 5;
    haGpsWatch(nowMs, moving);
    if (!trip && moving) haTripStart(nowMs);
    const t = trip;
    if (!t) return;
    if (moving) {
      t.movingSec++;
      t.lastMoveMs = nowMs;
      if (spd > t.max) t.max = spd;
      if (Number.isFinite(ev.tilt)) { const ta = Math.abs(ev.tilt); if (ta > (t.maxTiltAbs || 0)) t.maxTiltAbs = ta; }
      if (Number.isFinite(ev.rpm) && ev.rpm > 0 && ev.rpm > (t.maxRpm || 0)) t.maxRpm = ev.rpm;
      if (Number.isFinite(ev.load) && ev.load > 0 && ev.load > (t.maxLoad || 0)) t.maxLoad = ev.load;
      if (Number.isFinite(ev.throttle) && ev.throttle > 0 && ev.throttle > (t.maxThrottle || 0)) t.maxThrottle = ev.throttle;
      t.endMs = nowMs;
      const c = haPos && haPos.coords ? haPos.coords : null;
      const fixFresh = haGpsFixAgeMs(nowMs) < 30000;   // stary fix nie tworzy śladu ani km
      if (c && fixFresh && c.latitude != null && c.longitude != null) {
        if (t.lastFix && t.lastFix.latitude != null) {
          const d = haGpsDistKm(t.lastFix, c);
          if (d > 0 && d < 0.5) t.dist += d;
        }
        t.lastFix = c;
        const path = t.path || (t.path = []);
        const lastP = path.length ? path[path.length - 1] : null;
        if (path.length < 8000 && (!lastP || Math.abs(lastP.lat - c.latitude) > 0.00004 || Math.abs(lastP.lon - c.longitude) > 0.00004 || nowMs - lastP.t > 2500)) {
          path.push({ lat: c.latitude, lon: c.longitude, t: nowMs, spd: Math.round(spd) });
        }
      }
    }
    haTripStatus();
    if (moving) {
      gpsIdleMs = 0;
      if (!gpsNativeOn) haGpsStart();
    } else if (!trip && gpsNativeOn) {
      // Postój bez tripu: po 30 s wyłącz GPS (postój i tak nie tworzy śladu),
      // wraca przy ruszeniu.
      if (!gpsIdleMs) gpsIdleMs = nowMs;
      if (nowMs - gpsIdleMs > 30 * 1000) haGpsStop();
    } else if (trip && gpsNativeOn) {
      gpsIdleMs = 0;
    } else {
      gpsIdleMs = 0;
    }
  }
  function haTripHeart() {
    if (!trip || trip.movingSec <= 0) return;
    haTripSend("open");
  }
  function haTripSend(status) {
    const t = trip;
    if (!t) return;
    const url = (haCfg.url || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) { haTripStatus(); return; }
    const endD = new Date(t.endMs);
    const payload = {
      day: t.day,
      start: fmtIso(new Date(t.startMs)),
      end: fmtIso(endD),
      dist_km: Math.round(t.dist * 100) / 100,
      dur_min: Math.round(((t.endMs - t.startMs) / 60000) * 10) / 10,
      moving_min: Math.round((t.movingSec / 60) * 10) / 10,
      avg_kmh: t.movingSec > 0 ? Math.round(t.dist / (t.movingSec / 3600)) : 0,
      max_kmh: Math.round(t.max),
      max_tilt: Math.round((t.maxTiltAbs || 0) * 10) / 10,
      status: status,
    };
    const pts = (t.path || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    const step = Math.max(1, Math.ceil(pts.length / 700));
    const dsPath = [];
    for (let i = 0; i < pts.length; i += step) {
      dsPath.push([Math.round(pts[i].lat * 1e6) / 1e6, Math.round(pts[i].lon * 1e6) / 1e6]);
    }
    if (dsPath.length) payload.path = dsPath;
    if (status === "open") {
      haTripStatus();
    } else {
      tripsSaveDay(t.day, t);
      haTripCheckpointStop();
      trip = null;
    }
    const hookOk = /^https?:\/\//i.test(url);
    if (!hookOk) { if (status === "closed") haPendingSave(payload); return; }
    fetch(url + "/api/webhook/" + encodeURIComponent(TRIP_HOOK), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => {
        if (r.ok) {
          if (status === "closed") haSetTripStatus("Trip zapisany " + new Date().toLocaleTimeString(), "ok");
          else haSetTripStatus("Trip: " + payload.dist_km + " km", "ok");
        } else {
          haPendingSave(payload);
          haSetTripStatus("Błąd " + r.status + " — trip do kolejki", "err");
        }
      })
      .catch(() => {
        haPendingSave(payload);
        haSetTripStatus("Brak netu — trip w kolejce", "err");
      });
  }
  function haSetTripStatus(msg, cls) {
    const el = $("haTripStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = "setting-hint";
    if (cls) el.classList.add(cls);
  }
  function haTripCheckpoint() {
    if (!trip || !trip.path || trip.path.length < 2) return;
    try {
      localStorage.setItem(TRIPS_LIVE_KEY, JSON.stringify({
        day: trip.day,
        startMs: trip.startMs,
        endMs: trip.endMs,
        dist: trip.dist,
        max: trip.max,
        maxTiltAbs: trip.maxTiltAbs || 0,
        maxRpm: trip.maxRpm || 0,
        maxLoad: trip.maxLoad || 0,
        maxThrottle: trip.maxThrottle || 0,
        movingSec: trip.movingSec,
        path: trip.path,
        checkpointMs: Date.now(),
      }));
    } catch (e) { /* ignore quota */ }
  }
  function haTripCheckpointStart() {
    if (tripCheckpointTimer) return;
    tripCheckpointTimer = setInterval(haTripCheckpoint, 60 * 1000);
  }
  function haTripCheckpointStop() {
    if (tripCheckpointTimer) { clearInterval(tripCheckpointTimer); tripCheckpointTimer = null; }
    try { localStorage.removeItem(TRIPS_LIVE_KEY); } catch (e) {}
  }
  function haTripRestoreLive() {
    try {
      const raw = JSON.parse(localStorage.getItem(TRIPS_LIVE_KEY) || "null");
      if (!raw || !raw.path || raw.path.length < 2) { haTripCheckpointStop(); return; }
      const day = raw.day || dayNow();
      if (day !== dayNow()) { haTripCheckpointStop(); return; }
      trip = {
        day: day,
        startMs: raw.startMs || Date.now(),
        endMs: raw.endMs || Date.now(),
        lastMoveMs: raw.checkpointMs || Date.now(),
        dist: raw.dist || 0,
        max: raw.max || 0,
        maxTiltAbs: raw.maxTiltAbs || 0,
        maxRpm: raw.maxRpm || 0,
        maxLoad: raw.maxLoad || 0,
        maxThrottle: raw.maxThrottle || 0,
        movingSec: raw.movingSec || 0,
        lastFix: raw.path[raw.path.length - 1],
        path: raw.path,
      };
      haTripCheckpointStart();
      haSetTripStatus("Przywrócono trip z checkpointa", "ok");
    } catch (e) { haTripCheckpointStop(); }
  }
  function haSetConn(msg, cls) {
    const el = $("haConn");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "setting-hint";
    if (cls) el.classList.add(cls);
  }
  function haPing() {
    if (!haCfg.on || haPinging) return;
    const url = (haCfg.url || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) { haSetConn("Brak adresu HA", "warn"); haHaIcon("warn"); return; }
    haPinging = true;
    fetch(url + "/api/webhook/" + encodeURIComponent(TRIP_HOOK), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "ping" }),
    })
      .then((r) => {
        haPinging = false;
        if (r.ok) {
          haSetConn("Połączono z HA", "ok");
          haHaIcon("ok");
          haFlush();
        } else if (r.status === 404) { haSetConn("HA odpowiada, brak integracji Olejarka Trips", "warn"); haHaIcon("warn"); }
        else { haSetConn("Błąd serwera HA (" + r.status + ")", "err"); haHaIcon("err"); }
      })
      .catch(() => {
        haPinging = false;
        haSetConn("Brak połączenia z HA", "err");
        haHaIcon("err");
        haQueueNote();
      });
  }
  function haTripStatus() {
    const el = $("haTripStatus");
    if (!el || !trip) { if (el) el.textContent = ""; return; }
    const moving = trip.lastMoveMs && (Date.now() - trip.lastMoveMs) < 10 * 1000;
    const km = Math.round(trip.dist * 100) / 100;
    el.textContent = "Dzienny trip: " + (km > 0 ? km + " km" : "0 km") + (moving ? "" : " (postoj)");
    el.className = "setting-hint";
    el.classList.add("ok");
  }
  function haInit() {
    haLoad();
    haRender();
    $("haToggle").onclick = () => {
      haCfg.on = !haCfg.on;
      haSave();
      haRender();
      if (haCfg.on) haStart(); else haStop();
    };
    $("haSecMinus").onclick = () => {
      haCfg.sec = Math.max(5, haCfg.sec - 5);
      haSave();
      haRender();
      if (haCfg.on) haStart();
    };
    $("haSecPlus").onclick = () => {
      haCfg.sec = Math.min(120, haCfg.sec + 5);
      haSave();
      haRender();
      if (haCfg.on) haStart();
    };
    $("haUrl").addEventListener("change", haApply);
    $("haHook").addEventListener("change", haApply);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        haOnAppHide();
      } else if (document.visibilityState === "visible") {
        sendDateNow();
      }
    });
  }
  // --- Ustawienia: powiadomienia, mapa, VU, eksport GPX, zrzuty ekranu ---
  function updateAlertUi() {
    const set = (id, on) => { const el = $(id); if (el) { el.textContent = on ? "WŁ" : "WYŁ"; el.classList.toggle("on", on); } };
    set("alertBtBtn", alerts.bt);
    set("alertOilBtn", alerts.oil);
    set("alertTempBtn", alerts.temp);
    const oLab = $("alertOilLabel");
    if (oLab) oLab.textContent = "Niski poziom oleju (< " + oilAlertMl + " ml)";
    const oOut = $("oilLevelOut");
    if (oOut) oOut.textContent = oilAlertMl;
  }
  const oilLevelBinds = [["oilLevelMinus", -5], ["oilLevelPlus", 5]];
  for (const bind of oilLevelBinds) {
    const el = $(bind[0]);
    if (!el) continue;
    el.onclick = () => {
      oilAlertMl = Math.max(5, Math.min(60, oilAlertMl + bind[1]));
      try { localStorage.setItem("olejarOilLevelMl", String(oilAlertMl)); } catch (e) {}
      updateAlertUi();
    };
  }
  function persistAlerts() {
    try { localStorage.setItem("olejarAlerts", JSON.stringify(alerts)); } catch (e) {}
  }
  const ALERT_TOGGLE_IDS = { alertBtBtn: "bt", alertOilBtn: "oil", alertTempBtn: "temp" };
  for (const id in ALERT_TOGGLE_IDS) {
    const el = $(id);
    if (!el) continue;
    el.onclick = () => {
      alerts[ALERT_TOGGLE_IDS[id]] = !alerts[ALERT_TOGGLE_IDS[id]];
      persistAlerts();
      updateAlertUi();
    };
  }
  updateAlertUi();

  function updateMapCacheUi() {
    const b = $("mapOfflineBtn");
    if (b) { b.textContent = mapOffline ? "WŁ" : "WYŁ"; b.classList.toggle("on", mapOffline); }
    const st = $("mapCacheStatus");
    if (st) {
      st.textContent = mapCacheCount > 0
        ? "Kafelków w cache: " + mapCacheCount
        : (mapOffline ? "Cache pusty — włącz internet i przeglądaj okolicę w trybie mapy." : "Cache pusty.");
    }
  }
  const mapOfflineBtn = $("mapOfflineBtn");
  if (mapOfflineBtn) mapOfflineBtn.onclick = () => {
    mapOffline = !mapOffline;
    try { localStorage.setItem("olejarMapOffline", mapOffline ? "1" : "0"); } catch (e) {}
    updateMapCacheUi();
    if (document.body.classList.contains("trips")) tripsRecycle();
  };
  const mapCacheClearBtn = $("mapCacheClearBtn");
  if (mapCacheClearBtn) mapCacheClearBtn.onclick = () => {
    askConfirm("Wyczyścić cache kafelków mapy? W trybie offline mapa nie pokaże pobranej okolicy, dopóki nie ściągniesz jej ponownie.", true, "WYCZYŚĆ", "Cache mapy").then((ok) => { if (ok) tileClear(); });
  };
  updateMapCacheUi();
  tileCount();

  function updateVuUi() {
    if ($("vuLeanOut")) $("vuLeanOut").textContent = vuCfg.lean;
    if ($("vuYOut")) $("vuYOut").textContent = vuCfg.y;
    if ($("vuXOut")) $("vuXOut").textContent = vuCfg.x;
  }
  function applyVuCfg() {
    vuCfg.lean = Math.max(10, Math.min(120, Math.round(vuCfg.lean)));
    vuCfg.y = Math.max(-80, Math.min(80, Math.round(vuCfg.y)));
    vuCfg.x = Math.max(-80, Math.min(80, Math.round(vuCfg.x)));
    try { localStorage.setItem("olejarVuCfg", JSON.stringify(vuCfg)); } catch (e) {}
    leanFull = vuCfg.lean;
    updateVuUi();
    alignHeadActions();
  }
  const vuBinds = [
    ["vuLeanMinus", "lean", -1], ["vuLeanPlus", "lean", 1],
    ["vuYMinus", "y", -1], ["vuYPlus", "y", 1],
    ["vuXMinus", "x", -1], ["vuXPlus", "x", 1],
  ];
  for (const bind of vuBinds) {
    const el = $(bind[0]);
    if (!el) continue;
    el.onclick = () => {
      const key = bind[1];
      const step = key === "lean" ? 5 : 4;
      const lo = key === "lean" ? 10 : -80;
      const hi = key === "lean" ? 120 : 80;
      vuCfg[key] = Math.max(lo, Math.min(hi, vuCfg[key] + bind[2] * step));
      applyVuCfg();
    };
  }
  updateVuUi();
  leanFull = vuCfg.lean;

  function gpxEsc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function tripsBuildGpx(disp) {
    const rows = (disp && disp.rows) || [];
    const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
    out.push('<gpx version="1.1" creator="Olejarka" xmlns="http://www.topografix.com/GPX/1/1">');
    rows.forEach((r) => {
      const st = r.st ? r.st.replace("T", " ").slice(0, 16) : "";
      const name = "Trip" + (st ? " " + st : "") + " " + (Number(r.km) || 0).toFixed(1) + " km";
      out.push("  <trk><name>" + gpxEsc(name) + "</name>");
      out.push("    <trkseg>");
      (r.pts || []).forEach((p) => {
        let line = '      <trkpt lat="' + p.lat + '" lon="' + p.lon + '">';
        if (p.t && Number.isFinite(p.t)) line += "<time>" + new Date(p.t).toISOString() + "</time>";
        line += "</trkpt>";
        out.push(line);
      });
      out.push("    </trkseg>");
      out.push("    <extensions>");
      out.push("      <olejarka:dist_km>" + (Number(r.km) || 0) + "</olejarka:dist_km>");
      out.push("      <olejarka:moving_min>" + (Number(r.min) || 0) + "</olejarka:moving_min>");
      out.push("      <olejarka:max_kmh>" + (Number(r.max) || 0) + "</olejarka:max_kmh>");
      out.push("      <olejarka:max_tilt>" + (Number(r.tilt) || 0) + "</olejarka:max_tilt>");
      out.push("    </extensions>");
      out.push("  </trk>");
    });
    out.push("</gpx>");
    return out.join("\n");
  }
  function tripsExportGpx() {
    const input = $("tripDate");
    const day = input ? input.value : dayNow();
    const disp = tripsDisplayTrip(day, tripSelectedIdx);
    const hasPts = (disp.rows || []).some((r) => r.pts && r.pts.length >= 2);
    if (!hasPts) {
      askConfirm("Brak trasy do wyeksportowania dla wybranego dnia.", false, "OK", "Eksport GPX").then(() => {});
      return;
    }
    const b = bridge();
    if (b && b.saveTripFile) {
      b.saveTripFile("olejarka-tripy-" + day + ".gpx", tripsBuildGpx(disp));
    } else {
      askConfirm("Ta wersja aplikacji nie obsługuje zapisu GPX — zaktualizuj apkę.", false, "OK", "Eksport GPX").then(() => {});
    }
  }
  const tripsGpxBtn = $("tripsGpxBtn");
  if (tripsGpxBtn) tripsGpxBtn.onclick = tripsExportGpx;

  function tsTag() {
    const p = (n) => String(n).padStart(2, "0");
    const d = new Date();
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  const menuScreenBtn = $("menuScreenBtn");
  if (menuScreenBtn) menuScreenBtn.onclick = () => {
    toggleMenu(false);
    const b = bridge();
    if (b && b.saveScreen) b.saveScreen("olejarka-ekran-" + tsTag() + ".png");
  };
  const tripsSaveBtn = $("tripsSaveBtn");
  if (tripsSaveBtn) tripsSaveBtn.onclick = () => {
    const b = bridge();
    if (!b) return;
    if (tripMap && typeof tripMap.getCanvas === "function" && b.saveTripImage) {
      try {
        const url = tripMap.getCanvas().toDataURL("image/png");
        if (url && url.length > 200) { b.saveTripImage(url); return; }
      } catch (e) { /* fall through */ }
    }
    if (b.saveScreen) b.saveScreen("olejarka-trip-" + tsTag() + ".png");
  };

  // ---- HUD: orientacja pionowa (telefon w uchwycie pionowym) ----
  // Przełącznik w Ustawieniach → Wyświetlacz. Zapamiętany lokalnie; po stronie
  // natywnej ustawia blokadę orientacji (pion tylko dla widoku jazdy HUD).
  const HUD_VERT_KEY = "olejarHudVert";
  let hudVert = false;

  function hudVertLoad() {
    try { hudVert = localStorage.getItem(HUD_VERT_KEY) === "1"; } catch (e) { /* ignore */ }
  }

  function hudVertNotifyNative() {
    const b = bridge();
    if (b && typeof b.setHudVertical === "function") b.setHudVertical(hudVert);
  }

  function hudVertApply(notifyNative) {
    const btn = $("hudVertBtn");
    if (btn) btn.textContent = hudVert ? "PIONOWA" : "POZIOMA";
    document.body.classList.toggle("hud-vert", hudVert);
    // notifyNative === false używamy tylko na starcie: blokadę pionu wysyłamy
    // dopiero po zniknięciu splasha, żeby ekran startowy był zawsze poziomo.
    if (notifyNative !== false) hudVertNotifyNative();
    requestAnimationFrame(() => requestAnimationFrame(alignHeadActions));
  }

  function hudVertToggle() {
    hudVert = !hudVert;
    try { localStorage.setItem(HUD_VERT_KEY, hudVert ? "1" : "0"); } catch (e) { /* ignore */ }
    hudVertApply();
  }

  // ---- Kolumna OBD: Telemetria OBD | Podgląd nawigacji ----
  const OBD_COL_KEY = "olejarObdCol";
  const obdSideEl = document.querySelector(".hud-obd-side");
  const oilSideEl = document.querySelector(".hud-oil-side");
  const hudModeEl = $("hudMode");
  let obdColMode = "telemetry";
  let navCardState = null;

  function obdColLoad() {
    try { if (localStorage.getItem(OBD_COL_KEY) === "nav") obdColMode = "nav"; } catch (e) { /* ignore */ }
  }

  function obdColApply() {
    const nav = obdColMode === "nav";
    const navEl = $("hudNav");
    const head = obdSideEl ? obdSideEl.querySelector("h2") : null;
    // Siatka OBD w trybie nawigacji NIE jest chowana przez display:none — robi to
    // CSS (.nav-col: visibility: hidden + nakładka na siatce gridu kolumny),
    // żeby zachowała geometrię i znaczniki dwóch kart stały na tej samej
    // wysokości co w trybie telemetrii.
    if (navEl) navEl.hidden = !nav;
    if (head) head.textContent = nav ? "NAWIGACJA" : "OBD";
    if (obdSideEl) obdSideEl.classList.toggle("nav-col", nav);
    if (oilSideEl) oilSideEl.classList.toggle("with-mode", nav);
    if (hudModeEl && oilSideEl && obdSideEl) {
      const parent = hudModeEl.parentNode;
      if (nav && parent !== oilSideEl) oilSideEl.appendChild(hudModeEl);
      else if (!nav && parent !== obdSideEl) obdSideEl.appendChild(hudModeEl);
    }
    const btn = $("obdColBtn");
    if (btn) btn.textContent = nav ? "Podgląd nawigacji" : "Telemetria OBD";
    navRender();
    if (typeof alignHeadActions === "function") alignHeadActions();
  }

  // Przełącza kolumnę OBD ↔ nawigację; używane przez przycisk w ustawieniach
  // (🎛 Kafelki HUD) oraz gest w pionie na kolumnie.
  function toggleObdCol() {
    obdColMode = obdColMode === "nav" ? "telemetry" : "nav";
    try { localStorage.setItem(OBD_COL_KEY, obdColMode); } catch (e) { /* ignore */ }
    obdColApply();
  }

  // Gest na kolumnie OBD: dowolny swipe w pionie (góra lub dół) o dominacji
  // pionowej przełącza tryb OBD ↔ nawigacja. Tap (bez ruchu palca) zostaje
  // dla karty nawigacji (otwieranie okienka „Otwórz za pomocą…").
  let swipeStart = null;
  let swipeFired = false;
  if (obdSideEl) {
    obdSideEl.addEventListener("pointerdown", (e) => {
      swipeStart = { x: e.clientX, y: e.clientY };
      swipeFired = false;
    });
    obdSideEl.addEventListener("pointermove", (e) => {
      if (!swipeStart) return;
      const dx = e.clientX - swipeStart.x;
      const dy = e.clientY - swipeStart.y;
      if (Math.abs(dy) > 34 && Math.abs(dy) > Math.abs(dx) * 1.4) {
        swipeStart = null;
        swipeFired = true;
        toggleObdCol();
      }
    });
  }

  const NAV_ARROWS = "↰↱↶↷↺↻⬆⬇⬅➡⤴⤵⟵⟶▲▼◀▶↑↓←→↖↗🏁";

  // Nawigacje (Yanosik, Mapy, Google Maps PL/EN) wysyłają instrukcje słowami,
  // nie glifami — mapujemy typowe frazy na strzałki. Kolejność = priorytet
  // („ostro w lewo" ma wygrać z samym „w lewo", kierunek na rondzie — z „rondo").
  function navArrowFromText(s) {
    const t = " " + s.toLowerCase() + " ";
    const find = (...phrases) => phrases.some((p) => t.includes(p));
    if (find("dotarłeś do celu", "dotarles do celu", "dojechałeś", "dojechales",
             "you have arrived", "you've arrived", "youve arrived", "arrived", "destination"))
      return "🏁";
    if (find("zawróć", "zawroc", "zawrót", "zawrot", "zawracaj", "zawrócić", "zawrocic",
             "u-turn", "u turn", "uturn"))
      return "↺";
    if (find("ostro w lewo", "ostry zakręt w lewo", "ostry zakret w lewo", "sharp left", "hard left"))
      return "↰";
    if (find("ostro w prawo", "ostry zakręt w prawo", "ostry zakret w prawo", "sharp right", "hard right"))
      return "↱";
    if (find("łagodnie w lewo", "delikatnie w lewo", "łagodna lewa", "delikatna lewa", "lekko w lewo",
             "slight left", "bear left"))
      return "↖";
    if (find("łagodnie w prawo", "delikatnie w prawo", "łagodna prawa", "delikatna prawa", "lekko w prawo",
             "slight right", "bear right"))
      return "↗";
    if (find("skręć w lewo", "skrec w lewo", "jedź w lewo", "jedz w lewo", "zjedź w lewo", "zjedz w lewo",
             "trzymaj się lewej", "trzymaj sie lewej", "w lewo", "w lewą", "w lewa",
             "turn left", "keep left"))
      return "←";
    if (find("skręć w prawo", "skrec w prawo", "jedź w prawo", "jedz w prawo", "zjedź w prawo", "zjedz w prawo",
             "trzymaj się prawej", "trzymaj sie prawej", "w prawo", "w prawą", "w prawa",
             "turn right", "keep right"))
      return "→";
    if (find("prosto", "na wprost", "wprost", "straight", "continue straight", "go straight"))
      return "↑";
    if (find("rondo", "rondzie", "ronda", "rondem", "wjedź na rondo", "wjedz na rondo",
             "wjazd na rondo", "roundabout", "okrężny", "okrezny"))
      return "↻";
    return "";
  }

  // Karta jest sama w sobie przyciskiem: dotknięcie otwiera SYSTEMOWE okienko
  // „Otwórz za pomocą…" z zainstalowanymi nawigacjami — bez własnych przycisków.
  function navShortcuts() {
    const card = $("hudNavCard");
    if (!card) return;
    card.classList.add("tappable");
    card.onclick = () => {
      // Klik tuż po geście (przełączeniu trybu kolumny) — ignorujemy, żeby
      // przypadkiem nie otworzył okienka nawigacji w trakcie zmiany kolumny.
      if (swipeFired) { swipeFired = false; return; }
      const b = bridge();
      // Bez dostępu do powiadomień karta prowadzi do ustawień zamiast do map —
      // etapy i tak by nie dotarły (a podpowiedź na karcie mówi o czymś innym).
      if (b && !navPerm() && b.openNotificationSettings) { b.openNotificationSettings(); return; }
      if (b && b.openNavChooser) b.openNavChooser();
      else askConfirm("Ta wersja nie wspiera wyboru nawigacji — zaktualizuj apkę.", false, "OK", "Nawigacja").then(() => {});
    };
  }

  function navPerm() {
    // Prawda = dostęp do powiadomień włączony (lub brak mostka — przeglądarka).
    const b = bridge();
    if (!b || typeof b.navNotifyGranted !== "function") return true;
    try { return !!b.navNotifyGranted(); } catch (e) { return true; }
  }

  function navRender() {
    const card = $("hudNavCard");
    if (!card) return;
    if (obdColMode !== "nav") return;
    const active = !!navCardState;
    const redacted = active && !!navCardState.redacted;
    const perm = navPerm();
    // Jeden stan naraz: dane nawigacji (karta klikalna — dotknięcie otwiera wybór
    // mapy), „Brak nawigacji" (dotknij, aby otworzyć), treść ukryta przez system,
    // albo brak dostępu do powiadomień (podpowiedź, jak go włączyć).
    card.classList.toggle("empty", (!active || redacted) && perm);
    card.classList.toggle("no-perm", !active && !redacted && !perm);
    const arrow = $("hudNavArrow");
    const text = $("hudNavText");
    const sub = $("hudNavSub");
    if (active) {
      if (arrow) arrow.textContent = navCardState.arrow || "↑";
      if (text) text.textContent = navCardState.text || "—";
      if (sub) sub.textContent = redacted ? "" : (navCardState.sub || "");
    } else if (!perm) {
      if (arrow) arrow.textContent = "🔔";
      if (text) text.textContent = "Włącz dostęp do powiadomień";
      if (sub) sub.textContent = "Etapy nawigacji dotrą tu po włączeniu w Ustawieniach telefonu";
    } else {
      if (arrow) arrow.textContent = "↑";
      if (text) text.textContent = "Brak nawigacji — dotknij, aby otworzyć nawigację";
      if (sub) sub.textContent = "";
    }
  }

  window.__navPermRefresh = function () { navRender(); };

  window.__onNavNotify = function (json) {
    try {
      const d = JSON.parse(json);
      if (!d || typeof d !== "object") return;
      const title = String(d.title || "").trim();
      const text = String(d.text || "").trim();
      if (title === "__REDACTED__") {
        // System ukrył treść (telefon zablokowany / ustawienie poufności) —
        // pokazujemy uczciwy komunikat zamiast miejscownika redakcji.
        navCardState = { redacted: true, text: "Treść powiadomienia ukryta przez system — odblokuj telefon" };
        navRender();
        return;
      }
      if (!title && !text) {
        // Nawigacja zakończona/zamknięta — czyścimy kartę.
        navCardState = null;
      } else {
        // Treść może przyjść bez tytułu (Yanosik, Mapy.com wysyłają sam tekst
        // instrukcji) — wtedy cały komunikat jest główną linią, bez podtytułu.
        const combo = (title + " " + text).trim();
        let arrow = "";
        for (const ch of NAV_ARROWS) { if (combo.includes(ch)) { arrow = ch; break; } }
        // Słowne instrukcje („skręć w lewo", „na rondzie zjedź 2. zjazd") — nawigacje
        // wysyłają tekst, nie glify; dopasowujemy frazy do strzałek.
        if (!arrow) arrow = navArrowFromText(combo);
        // Bez wskazania kierunku (np. sam dystans „Za 100 m" między instrukcjami)
        // zostaje ostatnia strzałka — karta nie mruga do „prosto".
        if (!arrow && navCardState && navCardState.arrow) arrow = navCardState.arrow;
        if (!arrow) arrow = "↑";
        let t = (title || text || "—");
        if (t.length > 46) t = t.slice(0, 46).trimEnd() + "…";
        navCardState = { arrow, text: t, sub: title ? text : "" };
      }
      navRender();
    } catch (e) { /* ignore */ }
  };

  const obdColBtn = $("obdColBtn");
  if (obdColBtn) obdColBtn.onclick = toggleObdCol;
  const openNotificationSettings = () => {
    const b = bridge();
    if (b && b.openNotificationSettings) b.openNotificationSettings();
    else askConfirm("Ta wersja nie obsługuje ustawień powiadomień — zaktualizuj apkę.", false, "OK", "Powiadomienia").then(() => {});
  };
  const hudNavPermSettings = $("hudNavPermSettings");
  if (hudNavPermSettings) hudNavPermSettings.onclick = openNotificationSettings;

  obdColLoad();
  obdColApply();
  navShortcuts();

  hudVertLoad();
  // Ekran startowy zostaje poziomo — pion włączymy dopiero po jego zniknięciu.
  hudVertApply(false);
  const hudVertBtn = $("hudVertBtn");
  if (hudVertBtn) hudVertBtn.onclick = hudVertToggle;

  dateSyncLoad();
  wifiLoad();
  haInit();
  if (haCfg.on) haStart();
  haTripRestoreLive();
  tripsInit();
  window.nativePageReady = function () {
    const b = bridge();
    if (b && b.pageReady) b.pageReady();
  };
  window.nativeShowHud = showHud;
  window.haRequestExit = haRequestExit;
  window.nativeExitAsk = nativeExitAsk;
  window.nativeSendDate = () => sendDateNow();
  const splash = document.getElementById("splash");
  if (splash) {
    setTimeout(function () { splash.classList.add("hide"); }, 4000);
    setTimeout(function () {
      const p = splash.parentNode;
      if (p) p.removeChild(splash);
      // Splash zawsze poziomo — dopiero teraz oddajemy HUD do wybranej orientacji.
      hudVertNotifyNative();
    }, 4600);
  } else {
    hudVertNotifyNative();
  }
  renderConfig(null);
  refreshBleLock();
  // Kafelki HUD inicjalizujemy na samym końcu — po wszystkich definicjach, więc TDZ jest niemożliwy.
  tileLoad();
  tileRender(state);
  window.nativePageReady();
})();

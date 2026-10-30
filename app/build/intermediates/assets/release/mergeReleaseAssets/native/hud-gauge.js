/* ================================================================
   >>>>>> HUD: DOPASUJ TUTAJ <<<<<<
   Wszystko współśrodkowe: środek poziomy (200), ujście podków na dole = „baseY".
   „R" = promień linii środkowej łuku (grubość dokłada się z obu stron).
   „KĄT KOŃCA": 252 = jak w v67, np. 245 = końce niżej/szerzej.
   „baseY": linia dołu (ujścia) podków — 300 = jak było, 280 = cały HUD wyżej.
   ================================================================ */
const HUD_G = {
  baseY: 303, // linia ujścia/dołu podków (mniejsza = cały HUD wyżej)
  speedR: 178, // promień podkowy prędkości
  speedY: 0, // pionowe przesunięcie podkowy prędkości (ujemna = wyżej, dodatnia = niżej)
  progR: 216, // promień podkowy postępu
  arcR: 262, // promień łuków LOAD / TPS
  arcDeg: 252, // kąt końca łuków bocznych (start podkowy: 180)
};

function hudP(r, deg, cy) {
  const a = (deg * Math.PI) / 180;
  return (
    (200 + r * Math.cos(a)).toFixed(1) +
    " " +
    ((cy === undefined ? HUD_G.baseY : cy) + r * Math.sin(a)).toFixed(1)
  );
}

function hudHorse(r, cy) {
  return (
    "M" +
    hudP(r, 180, cy) +
    " A" +
    r +
    " " +
    r +
    " 0 1 1 " +
    hudP(r, 0, cy)
  );
}

const hudArcL =
  "M" +
  hudP(HUD_G.arcR, 180) +
  " A" +
  HUD_G.arcR +
  " " +
  HUD_G.arcR +
  " 0 0 1 " +
  hudP(HUD_G.arcR, HUD_G.arcDeg);
const hudArcR =
  "M" +
  hudP(HUD_G.arcR, 0) +
  " A" +
  HUD_G.arcR +
  " " +
  HUD_G.arcR +
  " 0 0 0 " +
  hudP(HUD_G.arcR, 540 - HUD_G.arcDeg);

function HUD_MARKUP() {
  const cy = HUD_G.baseY + (HUD_G.speedY || 0);
  return (
    `<svg class="hud-gauge" viewBox="0 0 400 400" aria-hidden="true">` +
    `<path class="hud-side-track" d="${hudArcL}" pathLength="100"></path>` +
    `<path class="hud-load-fill" id="hudLoadArc" d="${hudArcL}" pathLength="100"></path>` +
    `<path class="hud-side-track" d="${hudArcR}" pathLength="100"></path>` +
    `<path class="hud-throttle-fill" id="hudThrArc" d="${hudArcR}" pathLength="100"></path>` +
    `<path class="hud-speed-track" d="${hudHorse(HUD_G.speedR, cy)}" pathLength="100"></path>` +
    `<path class="hud-speed-fill" id="hudGaugeFill" d="${hudHorse(HUD_G.speedR, cy)}" pathLength="100"></path>` +
    `<path class="hud-progress-track" d="${hudHorse(HUD_G.progR)}" pathLength="100"></path>` +
    `<path class="hud-progress-fill" id="hudArcFill" d="${hudHorse(HUD_G.progR)}" pathLength="100"></path>` +
    `</svg>` +
    `<span class="hud-progress-tag"><b id="hudProgressVal">—%</b>POSTĘP</span>` +
    `<div class="hud-speed-read"><span id="hudSpeed">0</span><span class="hud-speed-unit">km/h</span></div>` +
    `<span class="hud-arc-label hud-arc-load">LOAD <b id="hudLoadVal">—%</b></span>` +
    `<span class="hud-arc-label hud-arc-throttle"><b id="hudThrVal">—%</b> TPS</span>`
  );
}
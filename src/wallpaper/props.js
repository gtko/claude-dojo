// Objets d'entraînement des thèmes (champ "prop" de theme.json), dessinés en code, sans image.
// Chaque entrée : function(x, px, colors, GROUND)
//   x       CanvasRenderingContext2D du fond d'écran
//   px      abscisse gauche de l'objet (118, comme le poteau) : zone de px-4 à px+20, de y 44 à GROUND
//   colors  [principal, accent], possiblement vide : les couleurs par défaut prennent le relais
//   GROUND  ligne du sol (114)
// Pas d'animation : le moteur fait trembler l'objet quand le perso le frappe.
(function () {
  'use strict';

  const OUT = '#1a1426';                       // contour sombre, comme index.html
  const TAU = Math.PI * 2;

  // Couleur n de colors, ou la valeur par défaut
  const pick = (colors, n, def) => (Array.isArray(colors) && colors[n]) || def;

  // #rrggbb éclairci (f > 0) ou assombri (f < 0) ; un autre format est rendu tel quel
  function shade(c, f) {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) return c;
    const n = parseInt(m[1], 16), target = f < 0 ? 0 : 255, k = Math.abs(f);
    const ch = (s) => { const v = (n >> s) & 255; return Math.round(v + (target - v) * k); };
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  // #rrggbb en rgba avec l'alpha a ; un autre format prend la couleur de repli fb (#rrggbb)
  function alpha(c, a, fb) {
    const m = /^#([0-9a-f]{6})$/i.exec(c) || /^#([0-9a-f]{6})$/i.exec(fb);
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // Ombre portée au sol, comme le poteau
  function groundShadow(x, cx, rx, GROUND) {
    x.fillStyle = 'rgba(0,0,0,.35)';
    x.beginPath(); x.ellipse(cx, GROUND + 1, rx, 3.5, 0, 0, TAU); x.fill();
  }

  // Forme pleine à contour sombre ; path() trace sa propre forme
  function shape(x, path, fill, lw = 1.3) {
    path(); x.fillStyle = fill; x.fill(); x.strokeStyle = OUT; x.lineWidth = lw; x.stroke();
  }
  const ell = (x, cx, cy, rx, ry, fill, lw) =>
    shape(x, () => { x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, TAU); }, fill, lw);
  const rrect = (x, l, t, w, h, r, fill, lw) =>
    shape(x, () => { x.beginPath(); x.roundRect(l, t, w, h, r); }, fill, lw);
  const rect = (x, l, t, w, h, fill, lw) =>
    shape(x, () => { x.beginPath(); x.rect(l, t, w, h); }, fill, lw);

  // Trait simple reliant une liste de points
  function stroke(x, pts, color, lw = 1) {
    x.strokeStyle = color; x.lineWidth = lw; x.beginPath();
    pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b)));
    x.stroke();
  }

  // Point plein
  function dot(x, cx, cy, r, fill) {
    x.fillStyle = fill; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
  }

  // Anneau sans remplissage (cernes du bois)
  function ring(x, cx, cy, rx, ry, color, lw) {
    x.strokeStyle = color; x.lineWidth = lw; x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, TAU); x.stroke();
  }

  // Étoile à n branches : R rayon des pointes, r rayon des creux
  function star(x, cx, cy, R, r, fill) {
    x.fillStyle = fill; x.beginPath();
    for (let k = 0; k < 10; k++) {
      const rad = k % 2 ? r : R, a = -Math.PI / 2 + (k * Math.PI) / 5;
      x.lineTo(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
    }
    x.closePath(); x.fill();
  }

  // Clou : tige métal de (x1,y1) vers (x2,y2), tête ronde au premier point
  function nail(x, x1, y1, x2, y2) {
    stroke(x, [[x1, y1], [x2, y2]], OUT, 2.6);
    stroke(x, [[x1, y1], [x2, y2]], '#c9d1e0', 1.2);
    ell(x, x1, y1, 2, 2, '#e6ebf3', .8);
  }

  // Bras articulé : tige sombre, reflet métal, coude et pince au bout
  function arm(x, pts) {
    stroke(x, pts, OUT, 4.2);
    stroke(x, pts, '#8d98aa', 2);
    const [, elbow, hand] = pts;
    ell(x, elbow[0], elbow[1], 1.6, 1.6, '#e6ebf3', .7);
    ell(x, hand[0], hand[1], 2.4, 2.4, '#c9d1e0', .9);
  }

  // dhd : pupitre de composition de la porte des étoiles (socle incliné bronze, disque rouge et bleu, boutons)
  function dhd(x, px, colors, GROUND) {
    const bronze = pick(colors, 0, '#b07a34'), red = pick(colors, 1, '#d9463b');
    const cx = px + 7, y = 66;                                              // y : centre du plateau
    groundShadow(x, cx, 12, GROUND);
    rect(x, px - 3, GROUND - 6, 22, 6, shade(bronze, -.35));                // socle au sol
    rrect(x, px + 1, y, 13, GROUND - 6 - y, 2, bronze);                      // fût
    shape(x, () => { x.beginPath(); x.moveTo(cx, 49); x.lineTo(cx + 3.2, 58); x.lineTo(cx - 3.2, 58); x.closePath(); },
      shade(bronze, .25), 1);                                                // chevron au sommet
    ell(x, cx, y + 1.5, 12, 7.5, shade(bronze, -.3));                       // épaisseur du plateau incliné
    ell(x, cx, y, 12, 7.5, shade(bronze, .15));                             // plateau incliné
    ell(x, cx, y, 9, 5.2, '#2b2440', 1);                                     // disque
    for (let k = 0; k < 8; k++) {                                            // boutons ronds sur le pourtour
      const a = (k * TAU) / 8;
      ell(x, cx + 7 * Math.cos(a), y + 3.7 * Math.sin(a), 1.2, 1.2, '#e8c879', .7);
    }
    ell(x, cx, y, 4.6, 2.7, '#3f7fd6', .9);                                  // anneau bleu
    ell(x, cx, y, 2.4, 1.3, red, .8);                                        // centre rouge
  }

  // log : rondin de bois debout, cernes sur la coupe du dessus, deux cordes
  function log(x, px, colors, GROUND) {
    const bark = pick(colors, 0, '#8a5530'), cut = pick(colors, 1, '#e8c48a');
    const cx = px + 7, top = 52, bot = GROUND - 2;
    groundShadow(x, cx, 10, GROUND);
    ell(x, cx, bot, 8.5, 2.6, shade(bark, -.4));                             // base
    rect(x, px - 1, top, 16, bot - top, bark);                               // fût
    x.fillStyle = 'rgba(0,0,0,.16)';                                         // sillons de l'écorce
    x.fillRect(px + 2.5, top + 8, 2, bot - top - 14);
    x.fillRect(px + 11, top + 12, 1.5, bot - top - 18);
    x.fillStyle = 'rgba(255,255,255,.12)';
    x.fillRect(px, top + 6, 1.4, bot - top - 16);
    x.fillStyle = shade(bark, -.45);                                         // nœud
    x.beginPath(); x.ellipse(px + 11, 88, 1.6, 2.4, 0, 0, TAU); x.fill();
    for (const y of [74, 95]) {                                              // cordes
      rect(x, px - 1, y, 16, 3, '#d9b77a', .9);
      x.save(); x.beginPath(); x.rect(px - 1, y, 16, 3); x.clip();
      for (let k = -1; k < 8; k++) {
        stroke(x, [[px - 1 + k * 2.4, y + 3], [px + 1 + k * 2.4, y]], 'rgba(60,40,20,.5)', .6);
      }
      x.restore();
    }
    ell(x, cx, top, 8, 4, cut);                                              // coupe du dessus
    ring(x, cx, top, 5.4, 2.7, '#a9743f', .8);                               // cernes
    ring(x, cx, top, 2.8, 1.4, '#a9743f', .7);
    dot(x, cx, top, .8, '#a9743f');
  }

  // grimoire : gros livre ancien debout sur un pupitre, tranche dorée, glyphe magique
  function grimoire(x, px, colors, GROUND) {
    const cover = pick(colors, 0, '#5b2a7a'), gold = pick(colors, 1, '#e0b84a');
    const cx = px + 6.5, top = 46, bot = 99;
    groundShadow(x, cx, 11, GROUND);
    // pupitre : fût et plan incliné qui porte le livre
    rect(x, cx - 2, 102, 4, GROUND - 4 - 102, '#4a2e1a', 1);
    ell(x, cx, GROUND - 3, 6.5, 2.4, '#4a2e1a', 1);
    shape(x, () => {
      x.beginPath(); x.moveTo(px - 3, 102); x.lineTo(px + 16, 96); x.lineTo(px + 17, 100.5); x.lineTo(px - 2, 107); x.closePath();
    }, '#7a4f2c', 1);
    // tranche dorée (côté des pages)
    shape(x, () => {
      x.beginPath(); x.moveTo(px + 13, top + 1); x.lineTo(px + 17, top + 3); x.lineTo(px + 17, bot - 2); x.lineTo(px + 13, bot); x.closePath();
    }, gold, 1);
    for (let yy = top + 5; yy < bot - 2; yy += 3) stroke(x, [[px + 13.4, yy], [px + 16.6, yy + .6]], 'rgba(120,80,20,.45)', .6);
    // couverture, dos sombre, bandes dorées
    rect(x, px - 1, top, 14, bot - top, cover);
    rect(x, px - 1, top, 2.4, bot - top, shade(cover, -.35), .9);
    rect(x, px - 1, top, 14, 2.2, gold, .9);
    rect(x, px - 1, bot - 2.2, 14, 2.2, gold, .9);
    // glyphe magique
    const gy = 72;
    const halo = x.createRadialGradient(cx, gy, 1, cx, gy, 10);
    halo.addColorStop(0, alpha(gold, .45, '#e0b84a')); halo.addColorStop(1, alpha(gold, 0, '#e0b84a'));
    x.fillStyle = halo; x.beginPath(); x.arc(cx, gy, 10, 0, TAU); x.fill();
    x.strokeStyle = gold; x.lineWidth = .9; x.beginPath(); x.arc(cx, gy, 4.8, 0, TAU); x.stroke();
    star(x, cx, gy, 3.6, 1.5, gold);
    // étincelles autour du livre
    dot(x, px - 3, 54, 1, gold);
    dot(x, px + 18, 60, 1.1, gold);
    dot(x, px + 19, 84, .8, gold);
  }

  // barrel : tonneau de bois bombé, douves et cerclages de fer
  function barrel(x, px, colors, GROUND) {
    const wood = pick(colors, 0, '#9a6234'), iron = pick(colors, 1, '#7d8799');
    const cx = px + 7, top = 58, bot = GROUND - 1;
    const body = () => {
      x.beginPath();
      x.moveTo(cx - 6, top);
      x.bezierCurveTo(cx - 13, top + 14, cx - 13, bot - 14, cx - 6, bot);
      x.lineTo(cx + 6, bot);
      x.bezierCurveTo(cx + 13, bot - 14, cx + 13, top + 14, cx + 6, top);
      x.closePath();
    };
    groundShadow(x, cx, 11, GROUND);
    ell(x, cx, bot, 6.5, 2.2, shade(wood, -.35));                           // fond visible
    body(); x.fillStyle = wood; x.fill();
    x.strokeStyle = OUT; x.lineWidth = 1.3; x.stroke();
    x.save(); body(); x.clip();                                             // douves et cerclages dans le corps
    for (const o of [-5, 0, 5]) {
      x.strokeStyle = 'rgba(40,20,5,.35)'; x.lineWidth = .8; x.beginPath();
      x.moveTo(cx + o, top); x.quadraticCurveTo(cx + o * 1.7, 86, cx + o, bot); x.stroke();
    }
    for (const y of [66, 88, 107]) {
      x.fillStyle = iron; x.fillRect(cx - 14, y - 1.4, 28, 2.8);
      stroke(x, [[cx - 14, y - 1.4], [cx + 14, y - 1.4]], OUT, .7);
      stroke(x, [[cx - 14, y + 1.4], [cx + 14, y + 1.4]], OUT, .7);
    }
    x.restore();
    body(); x.strokeStyle = OUT; x.lineWidth = 1.3; x.stroke();              // contour final
    ell(x, cx, top, 6.5, 2.6, shade(wood, .25));                            // couvercle
  }

  // robot : robot d'examen, corps cubique métal, œil rouge unique, bras mécaniques
  function robot(x, px, colors, GROUND) {
    const steel = pick(colors, 0, '#aeb8c8'), eye = pick(colors, 1, '#ff3b3b');
    const cx = px + 7, dark = shade(steel, -.4);
    groundShadow(x, cx, 10, GROUND);
    rrect(x, cx - 6, 102, 4.5, GROUND - 102, 1.5, dark);                    // jambes
    rrect(x, cx + 1.5, 102, 4.5, GROUND - 102, 1.5, dark);
    arm(x, [[cx - 8, 82], [cx - 13, 90], [cx - 10.5, 98]]);                 // bras mécaniques
    arm(x, [[cx + 8, 82], [cx + 13, 90], [cx + 10.5, 98]]);
    rrect(x, cx - 8.5, 78, 17, 28, 3, steel);                               // torse cubique
    rrect(x, cx - 5, 84, 10, 8, 1.5, shade(steel, -.2));                    // plastron
    for (const [dx, dy] of [[-6.4, 81], [6.4, 81], [-6.4, 103], [6.4, 103]]) dot(x, cx + dx, dy, .9, dark);
    rrect(x, cx - 11, 63, 3, 7, 1, dark);                                    // oreilles
    rrect(x, cx + 8, 63, 3, 7, 1, dark);
    stroke(x, [[cx, 54], [cx, 47]], OUT, 2.2);                              // antenne
    stroke(x, [[cx, 54], [cx, 47]], '#c9d1e0', .9);
    ell(x, cx, 46, 1.7, 1.7, '#e6ebf3', .7);
    rrect(x, cx - 9, 54, 18, 24, 6, steel);                                  // tête
    rrect(x, cx - 6.5, 58.5, 13, 13, 3, '#2b3240');                          // visage
    const glow = x.createRadialGradient(cx, 65, 1, cx, 65, 7);
    glow.addColorStop(0, alpha(eye, .45, '#ff3b3b')); glow.addColorStop(1, alpha(eye, 0, '#ff3b3b'));
    x.fillStyle = glow; x.beginPath(); x.arc(cx, 65, 7, 0, TAU); x.fill();
    ell(x, cx, 65, 3.5, 3.5, eye, .8);                                       // œil unique
    dot(x, cx - 1.1, 63.9, .9, 'rgba(255,255,255,.85)');
    stroke(x, [[cx - 3, 70.5], [cx + 3, 70.5]], '#0f1420', .9);            // grille
  }

  // doll : poupée maudite en chiffon, boutons pour yeux, coutures rouges, deux clous
  function doll(x, px, colors, GROUND) {
    const cloth = pick(colors, 0, '#cdb08a'), red = pick(colors, 1, '#b3261e');
    const cx = px + 7;
    groundShadow(x, cx, 9, GROUND);
    rrect(x, cx - 6, 98, 5, GROUND - 98, 2.5, cloth);                       // jambes
    rrect(x, cx + 1, 98, 5, GROUND - 98, 2.5, cloth);
    rrect(x, cx - 11, 80, 5, 12, 2.5, cloth);                               // bras
    rrect(x, cx + 6, 80, 5, 12, 2.5, cloth);
    rrect(x, cx - 7, 72, 14, 34, 5, cloth);                                 // corps
    x.save();
    x.setLineDash([1.6, 1.2]); x.lineWidth = 1.1; x.strokeStyle = red;     // coutures rouges
    for (const seam of [[[cx, 76], [cx, 106]], [[cx - 8.5, 82], [cx - 8.5, 90]], [[cx + 8.5, 82], [cx + 8.5, 90]],
      [[cx - 3.5, 100], [cx - 3.5, 110]], [[cx + 3.5, 100], [cx + 3.5, 110]]]) {
      x.beginPath(); x.moveTo(...seam[0]); x.lineTo(...seam[1]); x.stroke();
    }
    x.beginPath(); x.moveTo(cx - 3.2, 69.5); x.quadraticCurveTo(cx, 72.5, cx + 3.2, 69.5); x.stroke();  // bouche cousue
    x.restore();
    x.beginPath(); x.arc(cx, 64, 9.5, 0, TAU); x.fillStyle = cloth; x.fill();   // tête
    x.strokeStyle = OUT; x.lineWidth = 1.3; x.stroke();
    for (const r of [8.6, 7.4]) {                                            // mèches de fil
      x.beginPath(); x.arc(cx, 64, r, Math.PI * 1.1, Math.PI * 1.9); x.strokeStyle = '#4a2f22'; x.lineWidth = 1.1; x.stroke();
    }
    for (const ex of [cx - 3.6, cx + 3.6]) {                                 // yeux boutons
      ell(x, ex, 62.5, 2.3, 2.3, '#2a2030', .8);
      stroke(x, [[ex - 1.2, 62.5], [ex + 1.2, 62.5]], 'rgba(230,220,200,.55)', .5);
      stroke(x, [[ex, 61.3], [ex, 63.7]], 'rgba(230,220,200,.55)', .5);
    }
    nail(x, cx - 3, 83, cx + 1.5, 92);                                       // deux clous
    nail(x, cx + 3.5, 97, cx - 1, 106);
  }

  // staff : bâton de mage planté sur un support, cristal bleu lumineux et halo
  function staff(x, px, colors, GROUND) {
    const wood = pick(colors, 0, '#7a4e2d'), crystal = pick(colors, 1, '#5fc6ff');
    const cx = px + 7, bot = GROUND - 10;                                    // bot : sommet du support
    groundShadow(x, cx, 10, GROUND);
    const halo = x.createRadialGradient(cx, 49, 1, cx, 49, 15);
    halo.addColorStop(0, alpha(crystal, .5, '#5fc6ff')); halo.addColorStop(1, alpha(crystal, 0, '#5fc6ff'));
    x.fillStyle = halo; x.beginPath(); x.arc(cx, 49, 15, 0, TAU); x.fill();  // halo
    shape(x, () => {                                                          // support de pierre
      x.beginPath(); x.moveTo(cx - 6, GROUND - 1); x.lineTo(cx + 6, GROUND - 1); x.lineTo(cx + 4.4, bot); x.lineTo(cx - 4.4, bot); x.closePath();
    }, '#5e5e74', 1);
    rrect(x, cx - 6, bot - 2, 12, 3, 1, '#77778e', 1);
    rrect(x, cx - 1.8, 56, 3.6, bot - 2 - 56, 1.5, wood);                    // bâton
    stroke(x, [[cx - 0.6, 58], [cx - 0.6, bot - 4]], 'rgba(255,240,210,.22)', .9);
    stroke(x, [[cx - 1.5, 57], [cx - 5.5, 50]], OUT, 2.6);                  // griffes qui serrent le cristal
    stroke(x, [[cx + 1.5, 57], [cx + 5.5, 50]], OUT, 2.6);
    stroke(x, [[cx - 1.5, 57], [cx - 5.5, 50]], wood, 1.3);
    stroke(x, [[cx + 1.5, 57], [cx + 5.5, 50]], wood, 1.3);
    const cg = x.createLinearGradient(0, 41, 0, 58.5);
    cg.addColorStop(0, shade(crystal, .6)); cg.addColorStop(1, crystal);
    shape(x, () => {                                                          // cristal
      x.beginPath(); x.moveTo(cx, 41); x.lineTo(cx + 4.6, 49); x.lineTo(cx, 58.5); x.lineTo(cx - 4.6, 49); x.closePath();
    }, cg, 1.1);
    stroke(x, [[cx, 41], [cx, 58.5]], 'rgba(255,255,255,.55)', .6);
    stroke(x, [[cx - 4.6, 49], [cx + 4.6, 49]], 'rgba(255,255,255,.55)', .6);
    star(x, cx + 8, 44, 2.2, .7, '#ffffff');                                 // scintillements
    dot(x, cx - 8, 54, .8, '#ffffff');
  }

  window.DOJO_PROPS = { dhd, log, grimoire, barrel, robot, doll, staff };
})();

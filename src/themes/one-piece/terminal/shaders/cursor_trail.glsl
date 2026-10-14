// Sillage d'embruns : a chaque saut du curseur (clic, Ctrl+A/E...), une trainee d'ecume file de
// l'ancienne position vers la nouvelle, avec quelques gouttes qui retombent. Eteinte en 0.22 s.
// Pas de trainee pendant la frappe normale ni au redessin de la ligne par zsh.
const float DURATION = 0.22;                       // secondes
const float OPACITY  = 0.45;
const vec3  FOAM     = vec3(0.957, 0.945, 0.902);  // #f4f1e6
const vec3  SEA      = vec3(0.310, 0.820, 0.773);  // #4fd1c5

float hash(float n) { return fract(sin(n) * 43758.5453); }

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

float easeOut(float x) { return 1.0 - pow(1.0 - x, 3.0); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    fragColor = base;

    // xy = coin haut-gauche (origine en bas), zw = taille
    vec2 cur  = iCurrentCursor.xy  + vec2(iCurrentCursor.z,  -iCurrentCursor.w)  * 0.5;
    vec2 prev = iPreviousCursor.xy + vec2(iPreviousCursor.z, -iPreviousCursor.w) * 0.5;
    float lineH = max(iCurrentCursor.w, 1.0);
    if (distance(cur, prev) < lineH * 1.5) return;   // frappe normale
    if (abs(cur.y - prev.y) < lineH * 0.5) return;   // meme ligne : redessin zsh

    float t = clamp((iTime - iTimeCursorChange) / DURATION, 0.0, 1.0);
    if (t >= 1.0) return;

    vec2 tail = mix(prev, cur, easeOut(t));
    vec2 seg = cur - tail;
    float segLen = max(length(seg), 1.0);
    vec2 perp = vec2(-seg.y, seg.x) / segLen;
    float along = clamp(dot(fragCoord - tail, seg) / (segLen * segLen), 0.0, 1.0);

    // sillage d'ecume : fin a la queue, plus epais a la tete
    float w = lineH * mix(0.08, 0.30, along);
    float d = sdSegment(fragCoord, tail, cur);
    float wake = exp(-(d * d) / (w * w + 1e-3));

    // gouttes : reparties le long du sillage, projetees sur les cotes puis retombees
    float drops = 0.0;
    for (int i = 0; i < 7; i++) {
        float fi = float(i) + 1.0;
        float s = hash(fi * 12.9898);
        float o = hash(fi * 78.233) * 2.0 - 1.0;
        float r = 0.6 + 0.9 * hash(fi * 39.346);
        vec2 pos = mix(tail, cur, s) + perp * o * lineH * (0.5 + 1.2 * t);
        pos.y -= t * t * lineH * (1.5 + 2.0 * hash(fi * 7.31));   // gravite
        drops = max(drops, 1.0 - smoothstep(r, r + 0.8, length(fragCoord - pos)));
    }

    float fade = (1.0 - t) * (1.0 - t);
    float a = wake * mix(0.15, 0.7, along) * fade * OPACITY;
    vec3 rgb = mix(base.rgb, mix(SEA, FOAM, along), a);
    rgb = mix(rgb, FOAM, drops * (1.0 - t) * OPACITY);
    fragColor = vec4(rgb, base.a);
}

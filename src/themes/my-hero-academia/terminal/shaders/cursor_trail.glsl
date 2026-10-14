// Traînée d'éclairs de One For All : à chaque saut du curseur (clic, Ctrl+A/E…), un arc électrique vert
// part de l'ancienne position, crépite jusqu'à la nouvelle, puis s'éteint en 0.18 s.
// Mêmes déclencheurs que la traînée de référence : pas d'éclair en frappe normale ni au redessin zsh.
const float DURATION = 0.18;                       // secondes
const float OPACITY  = 0.60;
const int   SEGS     = 6;                          // sommets du zigzag
const vec3  GREEN    = vec3(0.235, 0.961, 0.604);  // #3cf59a
const vec3  CORE     = vec3(0.920, 1.000, 0.960);  // cœur presque blanc

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

// Distance à un éclair : polyligne de SEGS segments dont les sommets intermédiaires sont décalés au hasard
float boltDist(vec2 p, vec2 a, vec2 b, float seed, float amp) {
    vec2 n = normalize(vec2(-(b.y - a.y), b.x - a.x));
    float d = 1e6;
    vec2 prev = a;
    for (int i = 1; i <= SEGS; i++) {
        float f = float(i) / float(SEGS);
        float j = (i == SEGS) ? 0.0 : (hash(seed + float(i)) - 0.5) * 2.0 * amp;
        vec2 v = mix(a, b, f) + n * j;
        d = min(d, sdSegment(p, prev, v));
        prev = v;
    }
    return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    fragColor = base;

    // xy = coin haut-gauche (origine en bas), zw = taille
    vec2 cur  = iCurrentCursor.xy  + vec2(iCurrentCursor.z,  -iCurrentCursor.w)  * 0.5;
    vec2 prev = iPreviousCursor.xy + vec2(iPreviousCursor.z, -iPreviousCursor.w) * 0.5;

    float lineH = max(iCurrentCursor.w, 1.0);
    if (distance(cur, prev) < lineH * 1.5) return;   // pas d'éclair en frappe normale
    if (abs(cur.y - prev.y) < lineH * 0.5) return;   // même ligne : redessin zsh

    float t = clamp((iTime - iTimeCursorChange) / DURATION, 0.0, 1.0);
    if (t >= 1.0) return;

    // la pointe file vers la nouvelle position pendant les 40 % premiers de la durée
    vec2 head = mix(prev, cur, max(t / 0.4, 0.02));
    // le zigzag est redessiné à chaque image (crépitement) et reste unique à chaque saut
    float frame = mod(floor(iTime * 30.0), 64.0);
    float seed  = fract(iTimeCursorChange * 0.731) * 97.0 + frame * 3.0;
    float d = boltDist(fragCoord, prev, head, seed, lineH * 0.45);

    float core  = 1.0 - smoothstep(0.0, 1.1, d);     // trait net
    float halo  = exp(-d * 0.45) * 0.45;             // lueur verte
    float flick = 0.55 + 0.45 * hash(frame + 11.0);
    float fade  = (1.0 - t) * (1.0 - t);
    float a = clamp((core + halo) * fade * flick * OPACITY, 0.0, 1.0);
    vec3 col = mix(GREEN, CORE, core);
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

// Vortex bleu : traînée en spirale derrière le curseur lors des sauts (clic, Ctrl+A/E…).
// Le sillage porte des stries hélicoïdales qui glissent vers la tête, puis s'éteint en 0.2 s.
const float DURATION = 0.20;                       // secondes
const float OPACITY  = 0.45;
const vec3  CORE     = vec3(0.435, 0.827, 0.941);  // #6fd3f0, lumière de la tête
const vec3  DEEP     = vec3(0.231, 0.455, 0.831);  // #3b74d4, bleu profond de la queue

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
    if (distance(cur, prev) < lineH * 1.5) return;   // pas de traînée en frappe normale
    if (abs(cur.y - prev.y) < lineH * 0.5) return;   // même ligne : redessin zsh (géré par click.glsl)

    float t = clamp((iTime - iTimeCursorChange) / DURATION, 0.0, 1.0);
    if (t >= 1.0) return;

    vec2 tail = mix(prev, cur, easeOut(t));
    vec2 seg = cur - tail;
    float segLen = max(length(seg), 1e-4);
    vec2 nrm = vec2(-seg.y, seg.x) / segLen;
    float along = clamp(dot(fragCoord - tail, seg) / (segLen * segLen), 0.0, 1.0);

    // stries hélicoïdales : elles glissent vers la tête pendant l'effet
    float side  = dot(fragCoord - tail, nrm) / lineH;
    float swirl = 0.5 + 0.5 * sin(along * 9.0 - t * 12.0 + side * 1.5);

    // lame effilée : demi-largeur 0.30 × hauteur de ligne à la tête, 0.06 à la queue
    float halfW = lineH * mix(0.06, 0.30, along);
    float d = sdSegment(fragCoord, tail, cur);
    float shape = 1.0 - smoothstep(halfW - 1.0, halfW + 1.0, d);

    vec3 col = mix(DEEP, CORE, along) * (0.7 + 0.3 * swirl);
    float a = shape * (1.0 - t) * (1.0 - t) * mix(0.2, 1.0, along) * (0.75 + 0.25 * swirl) * OPACITY;
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

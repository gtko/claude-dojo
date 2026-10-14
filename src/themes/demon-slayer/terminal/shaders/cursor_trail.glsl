// Souffle de flamme : traînée qui passe du jaune pâle à la tête au rouge braise à la queue, avec un léger
// vacillement, lors des sauts de curseur (clic, Ctrl+A/E…). Elle s'éteint en 0.2 s.
const float DURATION = 0.20;                       // secondes
const float OPACITY  = 0.50;
const vec3  HOT      = vec3(0.949, 0.890, 0.701);  // #f2e3b3, cœur de la flamme
const vec3  FLAME    = vec3(0.910, 0.443, 0.290);  // #e8714a
const vec3  EMBER    = vec3(0.722, 0.251, 0.165);  // #b8402a, braise de la queue

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

    // vacillement : la flamme ondule latéralement, d'autant plus vers la tête
    float wob = sin(along * 9.0 - t * 24.0) * lineH * 0.35 * along;
    float d = sdSegment(fragCoord - nrm * wob, tail, cur);
    float halfW = lineH * mix(0.05, 0.32, along);
    float shape = 1.0 - smoothstep(halfW - 1.0, halfW + 1.0, d);

    float flick = 0.8 + 0.2 * sin(along * 21.0 - t * 40.0);
    vec3 col = mix(EMBER, FLAME, smoothstep(0.0, 0.6, along));
    col = mix(col, HOT, smoothstep(0.6, 1.0, along));
    float a = shape * (1.0 - t) * (1.0 - t) * mix(0.25, 1.0, along) * flick * OPACITY;
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

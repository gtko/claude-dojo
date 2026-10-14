// Mana spark trail: cyan and gold sparks rise from the path the cursor jumps along.
// Only fires on real jumps (not typing, not same-line redraws). Fades in about 0.5 s.
const int   SPARKS    = 12;
const float DURATION  = 0.30;                       // time for the sparks to appear along the path (s)
const float LIFE      = 0.22;                       // lifetime of one spark (s)
const vec3  MANA_CYAN = vec3(0.373, 0.863, 0.925);  // #5fdcec
const vec3  GOLD      = vec3(0.914, 0.647, 0.290);  // #e9a54a
const float OPACITY   = 0.60;

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

float hash(float n) { return fract(sin(n) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    fragColor = base;

    // xy = top-left corner (origin at bottom), zw = size
    vec2 cur  = iCurrentCursor.xy  + vec2(iCurrentCursor.z,  -iCurrentCursor.w)  * 0.5;
    vec2 prev = iPreviousCursor.xy + vec2(iPreviousCursor.z, -iPreviousCursor.w) * 0.5;

    float lineH = max(iCurrentCursor.w, 1.0);
    if (distance(cur, prev) < lineH * 1.5) return;   // normal typing: no trail
    if (abs(cur.y - prev.y) < lineH * 0.5) return;   // same-line redraw

    float t = iTime - iTimeCursorChange;             // seconds since the jump
    if (t < 0.0 || t > DURATION + LIFE) return;
    if (sdSegment(fragCoord, prev, cur) > lineH * 2.0) return;   // only near the path

    vec2 seg = cur - prev;
    vec2 perp = normalize(vec2(-seg.y, seg.x));
    vec3 acc = vec3(0.0);
    for (int i = 0; i < SPARKS; i++) {
        float fi = float(i);
        float s = hash(fi * 3.1 + 1.0);              // position along the path
        float u = (t - s * DURATION) / LIFE;         // 0 = birth, 1 = gone
        if (u < 0.0 || u > 1.0) continue;
        float jit = hash(fi * 5.7 + 2.0) - 0.5;      // sideways scatter
        vec2 pos = mix(prev, cur, s) + perp * jit * lineH * 0.8 + vec2(0.0, u * lineH * 0.6);
        float r = mix(1.8, 0.4, u);                  // sparks shrink as they rise
        float d = length(fragCoord - pos);
        float glow = exp(-d * d / (2.0 * r * r));
        vec3 c = mix(MANA_CYAN, GOLD, step(0.5, hash(fi * 11.9 + 4.0)));
        acc += c * glow * (1.0 - u) * (1.0 - u);
    }
    fragColor = vec4(base.rgb + acc * OPACITY, base.a);
}

// Kunai trail: a tapered orange streak behind the cursor when it jumps (click, Ctrl+A/E...).
// Wide at the head, pointed at the tail, gone in 0.14 s.
const float DURATION = 0.14;                      // seconds
const vec3  TRAIL    = vec3(0.949, 0.549, 0.157); // #f28c28
const float OPACITY  = 0.50;

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

float easeOut(float x) { return 1.0 - pow(1.0 - x, 3.0); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    fragColor = base;

    // xy = top-left corner (origin at bottom), zw = size
    vec2 cur  = iCurrentCursor.xy  + vec2(iCurrentCursor.z,  -iCurrentCursor.w)  * 0.5;
    vec2 prev = iPreviousCursor.xy + vec2(iPreviousCursor.z, -iPreviousCursor.w) * 0.5;

    float lineH = max(iCurrentCursor.w, 1.0);
    if (distance(cur, prev) < lineH * 1.5) return;   // normal typing: no trail
    if (abs(cur.y - prev.y) < lineH * 0.5) return;   // same-line redraw (handled by click)

    float t = clamp((iTime - iTimeCursorChange) / DURATION, 0.0, 1.0);
    if (t >= 1.0) return;

    vec2 tail = mix(prev, cur, easeOut(t));
    vec2 seg = cur - tail;
    float along = clamp(dot(fragCoord - tail, seg) / max(dot(seg, seg), 1e-4), 0.0, 1.0);

    // tapered blade: half-width 0.28 x line height at the head, 0.06 at the tail
    float halfW = lineH * mix(0.06, 0.28, along);
    float d = sdSegment(fragCoord, tail, cur);
    float shape = 1.0 - smoothstep(halfW - 1.0, halfW + 1.0, d);

    float a = shape * (1.0 - t) * (1.0 - t) * mix(0.2, 1.0, along) * OPACITY;
    fragColor = vec4(mix(base.rgb, TRAIL, a), base.a);
}

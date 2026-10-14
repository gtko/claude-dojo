// Magic circle: on focus gain, a cyan rune circle draws itself clockwise around the
// screen centre, then a gold hexagram and rune ticks appear inside. The sigil fades
// out in about 1.1 s. Thin, low-opacity strokes keep the text readable.
const float DURATION = 1.10;                        // seconds
const float OPACITY  = 0.35;
const vec3  MANA_CYAN = vec3(0.373, 0.863, 0.925);  // #5fdcec
const vec3  GOLD      = vec3(0.965, 0.851, 0.557);  // #f6d98e
const float PI  = 3.14159265;
const float TAU = 6.28318531;

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

// Anti-aliased coverage of a stroke with half-width w (px) at distance d.
float stroke(float d, float w) { return 1.0 - smoothstep(w - 0.75, w + 0.75, d); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    float fade = 1.0 - smoothstep(0.6, 1.0, t);
    vec2 c = iResolution.xy * 0.5;
    vec2 d = fragCoord - c;
    float dist = length(d);
    float R  = min(iResolution.x, iResolution.y) * 0.30;   // outer radius
    float Rh = R * 0.82;                                    // inner radius
    // clockwise angle from 12 o'clock, in [0, TAU)
    float ang = mod(PI * 0.5 - atan(d.y, d.x + 1e-6), TAU);   // avoid atan(0, 0) at the exact centre

    // outer and inner rings draw themselves
    float ring1 = stroke(abs(dist - R), 0.7)  * step(ang, smoothstep(0.0, 0.45, t) * TAU);
    float ring2 = stroke(abs(dist - Rh), 0.7) * step(ang, smoothstep(0.2, 0.6, t) * TAU);

    // 12 rune ticks between the inner ring and the outer ring
    float ticks = 0.0;
    for (int k = 0; k < 12; k++) {
        float a = float(k) * TAU / 12.0;
        vec2 dir = vec2(cos(a), sin(a));
        ticks = max(ticks, stroke(sdSegment(d, dir * Rh, dir * R * 0.95), 0.7));
    }
    ticks *= smoothstep(0.45, 0.65, t);

    // hexagram: edges k -> k+2 on the inner circle, appear after the rings
    float star = 0.0;
    for (int k = 0; k < 6; k++) {
        float a0 = PI * 0.5 + float(k) * TAU / 6.0;
        float a1 = PI * 0.5 + float(k + 2) * TAU / 6.0;
        vec2 A = vec2(cos(a0), sin(a0)) * Rh;
        vec2 B = vec2(cos(a1), sin(a1)) * Rh;
        star = max(star, stroke(sdSegment(d, A, B), 0.6));
    }
    star *= smoothstep(0.5, 0.75, t);

    vec3 col = mix(base.rgb, MANA_CYAN, max(ring1, ring2) * OPACITY * fade);
    col = mix(col, GOLD, max(ticks, star) * OPACITY * fade);
    fragColor = vec4(col, base.a);
}

// Mana halo: bright areas bleed a soft cyan glow at the top of the screen,
// shifting to gold near the prompt. Low strength so the text stays readable.
const float THRESHOLD = 0.60;
const float STRENGTH  = 0.20;
const float RADIUS    = 4.0;                        // screen px
const int   TAPS      = 16;
const vec3  MANA_CYAN = vec3(0.373, 0.863, 0.925);  // #5fdcec
const vec3  GOLD      = vec3(0.914, 0.647, 0.290);  // #e9a54a

vec3 brightPart(vec2 uv) {
    vec3 c = texture(iChannel0, uv).rgb;
    float hi = max(c.r, max(c.g, c.b));
    float sat = hi - min(c.r, min(c.g, c.b));
    return c * smoothstep(THRESHOLD, 1.0, hi) * (0.25 + 0.75 * sat);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 px = 1.0 / iResolution.xy;
    vec2 uv = fragCoord * px;
    vec4 base = texture(iChannel0, uv);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996323;                       // golden angle
        float r = RADIUS * 2.0 * sqrt(fi / float(TAPS));
        float w = exp(-(r * r) / (2.0 * RADIUS * RADIUS));
        acc += brightPart((fragCoord + vec2(cos(a), sin(a)) * r) * px) * w;
        wsum += w;
    }
    vec3 mana = mix(GOLD, MANA_CYAN, smoothstep(0.15, 0.85, uv.y));
    vec3 halo = (acc / wsum) * mana * 1.6;
    fragColor = vec4(base.rgb + halo * STRENGTH, base.a);
}

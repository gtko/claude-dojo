// Subtle chakra glow: bright areas bleed a soft halo, blue at the top of the screen
// shifting to orange near the prompt. Low intensity so the text stays readable.
const float THRESHOLD     = 0.55;
const float STRENGTH      = 0.22;
const float RADIUS        = 5.0;                        // screen px
const int   TAPS          = 24;
const vec3  CHAKRA_BLUE   = vec3(0.231, 0.357, 0.647);  // #3b5ba5
const vec3  CHAKRA_ORANGE = vec3(0.949, 0.549, 0.157);  // #f28c28

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
    vec3 chakra = mix(CHAKRA_ORANGE, CHAKRA_BLUE, smoothstep(0.15, 0.85, uv.y));
    vec3 halo = (acc / wsum) * chakra * 1.6;
    fragColor = vec4(base.rgb + halo * STRENGTH, base.a);
}

// Subtle chakra glow: bright areas bleed a soft halo, blue at the top of the screen
// shifting to orange near the prompt. Low intensity so the text stays readable.
const float THRESHOLD     = 0.55;
const float STRENGTH      = 0.22;
const float RADIUS        = 5.0;                        // screen px
const int   TAPS          = 7;   // 7 samples + base = 8 fetches per pixel
// Offsets (px) and weights precomputed for RADIUS: golden-angle spiral, weights sum to 1.
const vec2  OFFS[TAPS] = vec2[TAPS](
    vec2(0.968, 2.491),
    vec2(-4.151, -2.048),
    vec2(5.738, -1.670),
    vec2(-3.671, 6.043),
    vec2(-1.559, -7.865),
    vec2(7.144, 5.247),
    vec2(-9.580, 1.041)
);
const float WGT[TAPS] = float[TAPS](0.28742, 0.21599, 0.16231, 0.12197, 0.09166, 0.06888, 0.05176);
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
    for (int i = 0; i < TAPS; i++) {
        acc += brightPart((fragCoord + OFFS[i]) * px) * WGT[i];
    }
    vec3 chakra = mix(CHAKRA_ORANGE, CHAKRA_BLUE, smoothstep(0.15, 0.85, uv.y));
    vec3 halo = acc * chakra * 1.6;
    fragColor = vec4(base.rgb + halo * STRENGTH, base.a);
}

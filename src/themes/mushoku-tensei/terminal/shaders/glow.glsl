// Mana halo: bright areas bleed a soft cyan glow at the top of the screen,
// shifting to gold near the prompt. Low strength so the text stays readable.
const float THRESHOLD = 0.60;
const float STRENGTH  = 0.20;
const float RADIUS    = 4.0;                        // screen px
const int   TAPS      = 7;   // 7 samples + base = 8 fetches per pixel
// Offsets (px) and weights precomputed for RADIUS: golden-angle spiral, weights sum to 1.
const vec2  OFFS[TAPS] = vec2[TAPS](
    vec2(0.775, 1.993),
    vec2(-3.321, -1.639),
    vec2(4.590, -1.336),
    vec2(-2.937, 4.835),
    vec2(-1.248, -6.292),
    vec2(5.716, 4.197),
    vec2(-7.664, 0.833)
);
const float WGT[TAPS] = float[TAPS](0.28742, 0.21599, 0.16231, 0.12197, 0.09166, 0.06888, 0.05176);
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
    for (int i = 0; i < TAPS; i++) {
        acc += brightPart((fragCoord + OFFS[i]) * px) * WGT[i];
    }
    vec3 mana = mix(GOLD, MANA_CYAN, smoothstep(0.15, 0.85, uv.y));
    vec3 halo = acc * mana * 1.6;
    fragColor = vec4(base.rgb + halo * STRENGTH, base.a);
}

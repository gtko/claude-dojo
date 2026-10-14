// Halo de mana : les parties claires du texte diffusent une lueur lavande tres douce,
// qui respire lentement. Sept echantillons (plus la base, soit 8 par pixel), pour rester leger.
const int   TAPS      = 7;   // 7 echantillons + base = 8 lectures par pixel
// Decalages (px) et poids precalcules pour RADIUS : spirale angle d'or, poids de somme 1.
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
const float RADIUS    = 4.0;                       // px ecran
const float THRESHOLD = 0.6;
const float STRENGTH  = 0.18;
const vec3  HALO_A    = vec3(0.722, 0.604, 0.839); // #b89ad6
const vec3  HALO_B    = vec3(0.663, 0.816, 0.961); // #a9d0f5

vec3 brightPart(vec2 uv) {
    vec3 c = texture(iChannel0, uv).rgb;
    float hi = max(c.r, max(c.g, c.b));
    return c * smoothstep(THRESHOLD, 1.0, hi);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 px = 1.0 / iResolution.xy;
    vec4 base = texture(iChannel0, fragCoord * px);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < TAPS; i++) {
        acc += brightPart((fragCoord + OFFS[i]) * px) * WGT[i];
    }
    vec3 tint = mix(HALO_A, HALO_B, 0.5 + 0.5 * sin(iTime * 0.3));
    float breath = 0.85 + 0.15 * sin(iTime * 0.9);
    vec3 halo = acc * tint * 1.4;
    fragColor = vec4(base.rgb + halo * STRENGTH * breath, base.a);
}

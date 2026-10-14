// Halo vert discret : les parties vives du texte diffusent une lueur verte très douce (style One For All).
// Sept échantillons (plus la base, soit 8 par pixel) pour rester léger ; intensité faible, la lisibilité prime.
const float THRESHOLD = 0.50;
const float STRENGTH  = 0.20;
const float RADIUS    = 5.0;                        // px écran
const int   TAPS      = 7;   // 7 échantillons + base = 8 lectures par pixel
// Décalages (px) et poids précalculés pour RADIUS : spirale angle d'or, poids de somme 1.
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
const vec3  GREEN     = vec3(0.235, 0.961, 0.604);  // #3cf59a

vec3 brightPart(vec2 uv) {
    vec3 c = texture(iChannel0, uv).rgb;
    float hi = max(c.r, max(c.g, c.b));
    return c * smoothstep(THRESHOLD, 1.0, hi);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 px = 1.0 / iResolution.xy;
    vec2 uv = fragCoord * px;
    vec4 base = texture(iChannel0, uv);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < TAPS; i++) {
        acc += brightPart((fragCoord + OFFS[i]) * px) * WGT[i];
    }
    vec3 halo = acc * GREEN;
    fragColor = vec4(base.rgb + halo * STRENGTH, base.a);
}

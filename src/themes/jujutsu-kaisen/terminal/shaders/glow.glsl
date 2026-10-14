// Halo sombre discret : autour des glyphes clairs, le fond s'assombrit très légèrement et un voile violet
// s'installe (aura de malédiction). Le texte lui-même n'est pas modifié : seul le fond sombre est touché.
// Sept échantillons (plus la base, soit 8 par pixel) pour rester léger.
const float RADIUS = 6.0;                              // px écran
const int   TAPS   = 7;                                // 7 échantillons + base = 8 lectures par pixel
// Décalages (px) et poids précalculés pour RADIUS : spirale angle d'or, poids de somme 1.
const vec2  OFFS[TAPS] = vec2[TAPS](
    vec2(1.162, 2.989),
    vec2(-4.982, -2.458),
    vec2(6.886, -2.004),
    vec2(-4.405, 7.252),
    vec2(-1.871, -9.438),
    vec2(8.573, 6.296),
    vec2(-11.496, 1.249)
);
const float WGT[TAPS] = float[TAPS](0.28742, 0.21599, 0.16231, 0.12197, 0.09166, 0.06888, 0.05176);
const float SHADE  = 0.45;                             // assombrissement du fond proche du texte
const float HAZE   = 0.07;                             // intensité du voile violet
const vec3  DARK   = vec3(0.030, 0.010, 0.060);
const vec3  VIOLET = vec3(0.690, 0.424, 1.000);        // #b06cff
const vec3  LUMA   = vec3(0.299, 0.587, 0.114);

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 px = 1.0 / iResolution.xy;
    vec4 base = texture(iChannel0, fragCoord * px);
    float lum = dot(base.rgb, LUMA);

    // proximité d'un glyphe clair : moyenne pondérée des pixels vifs voisins
    float near = 0.0;
    for (int i = 0; i < TAPS; i++) {
        vec3 s = texture(iChannel0, (fragCoord + OFFS[i]) * px).rgb;
        near += smoothstep(0.3, 0.8, dot(s, LUMA)) * WGT[i];
    }

    // seul le fond sombre est modulé : au-delà de lum 0.35 (glyphes), le masque vaut 0 et le texte reste intact
    float bgMask = 1.0 - smoothstep(0.15, 0.35, lum);
    vec3 rgb = mix(base.rgb, DARK, clamp(near * SHADE * bgMask, 0.0, 1.0));
    rgb += VIOLET * near * HAZE * bgMask;
    fragColor = vec4(rgb, base.a);
}

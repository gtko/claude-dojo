// Halo sombre discret : autour des glyphes clairs, le fond s'assombrit très légèrement et un voile violet
// s'installe (aura de malédiction). Le texte lui-même n'est pas modifié : seul le fond sombre est touché.
// Douze échantillons seulement pour rester léger.
const float RADIUS = 6.0;                              // px écran
const int   TAPS   = 12;
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
    float wsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996323;                     // angle d'or
        float r = RADIUS * 2.0 * sqrt(fi / float(TAPS));
        float w = exp(-(r * r) / (2.0 * RADIUS * RADIUS));
        vec3 s = texture(iChannel0, (fragCoord + vec2(cos(a), sin(a)) * r) * px).rgb;
        near += smoothstep(0.3, 0.8, dot(s, LUMA)) * w;
        wsum += w;
    }
    near /= wsum;

    // seul le fond sombre est modulé : au-delà de lum 0.35 (glyphes), le masque vaut 0 et le texte reste intact
    float bgMask = 1.0 - smoothstep(0.15, 0.35, lum);
    vec3 rgb = mix(base.rgb, DARK, clamp(near * SHADE * bgMask, 0.0, 1.0));
    rgb += VIOLET * near * HAZE * bgMask;
    fragColor = vec4(rgb, base.a);
}

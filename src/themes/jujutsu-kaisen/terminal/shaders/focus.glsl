// Déploiement de domaine : au retour du focus, un voile sombre violet s'étend depuis le centre jusqu'aux bords
// (0.9 s), bordé d'un liseré et d'un maillage fin, puis se dissout. Voile léger : le texte reste lisible.
const float DURATION = 0.90;                          // secondes
const float VEIL_A   = 0.18;                          // opacité maximale du voile
const float GRID     = 42.0;                          // pas du maillage (px)
const vec3  VEIL     = vec3(0.030, 0.000, 0.080);     // violet très sombre, plus sombre que le fond
const vec3  RIM      = vec3(0.690, 0.424, 1.000);     // #b06cff

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    vec2 center = iResolution.xy * 0.5;
    float dist  = length(fragCoord - center);
    float maxR  = length(iResolution.xy * 0.5) * 1.05;     // couvre toute la fenêtre
    float ease  = 1.0 - pow(1.0 - t, 3.0);
    float r     = maxR * ease;                              // rayon du domaine
    float inside = 1.0 - smoothstep(r - 2.0, r, dist);
    // enveloppe : monte vite, tient, puis se dissout
    float env = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.45, 1.0, t));

    // maillage fin à l'intérieur du voile
    vec2 g = abs(fract((fragCoord - center) / GRID) - 0.5);
    float lines = 1.0 - smoothstep(0.46, 0.5, max(g.x, g.y));

    vec3 col = mix(base.rgb, VEIL, inside * env * VEIL_A);
    col += RIM * lines * inside * env * 0.05;
    // liseré qui marque la frontière du domaine
    float ring = (1.0 - smoothstep(0.0, 2.5, abs(dist - r))) * (1.0 - t) * 0.4;
    col = mix(col, RIM, ring);
    fragColor = vec4(col, base.a);
}

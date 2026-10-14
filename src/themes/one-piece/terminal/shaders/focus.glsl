// Vague au retour du focus : une lame turquoise et sa creste d'ecume balaient l'ecran
// de gauche a droite en 0.9 s. Tres faible opacite, la creste reste sous le texte.
const float DURATION = 0.9;                        // secondes
const float BAND_A   = 0.08;
const float CREST_A  = 0.20;
const vec3  SEA      = vec3(0.310, 0.820, 0.773);  // #4fd1c5
const vec3  FOAM     = vec3(0.957, 0.945, 0.902);  // #f4f1e6

float hash(float n) { return fract(sin(n) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 res = iResolution.xy;
    vec4 base = texture(iChannel0, fragCoord / res);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    float e = 1.0 - pow(1.0 - t, 2.0);             // avance rapide puis ralentit
    float front = mix(-0.2, 1.2, e) * res.x;
    // la creste ondule en hauteur
    float wob = sin(fragCoord.y * 0.035 + iTime * 9.0) * 9.0
              + sin(fragCoord.y * 0.011 - iTime * 4.0) * 14.0;
    float behind = front + wob - fragCoord.x;      // > 0 : a gauche de la creste

    float band = smoothstep(0.0, 6.0, behind) * (1.0 - smoothstep(60.0, 220.0, behind));
    float crest = exp(-(behind * behind) / 16.0) * (0.55 + 0.45 * hash(floor(fragCoord.y * 0.5)));
    float env = 1.0 - smoothstep(0.6, 1.0, t);

    vec3 rgb = mix(base.rgb, SEA, band * BAND_A * env);
    rgb = mix(rgb, FOAM, crest * CREST_A * env);
    fragColor = vec4(rgb, base.a);
}

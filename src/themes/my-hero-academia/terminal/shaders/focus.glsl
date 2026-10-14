// Arc électrique au retour du focus : un éclair vertical traverse la fenêtre de gauche à droite en 0.45 s
// et laisse une traînée verte qui s'éteint. Le zigzag est recalculé à chaque image.
// Opacité faible : le texte reste lisible pendant tout l'effet.
const float DURATION = 0.45;                       // secondes
const float MAX_A    = 0.25;                       // opacité maximale du trait
const float BAND     = 48.0;                       // hauteur d'un segment de l'éclair (px)
const float AMP      = 36.0;                       // amplitude latérale du zigzag (px)
const vec3  GREEN    = vec3(0.235, 0.961, 0.604);  // #3cf59a
const vec3  CORE     = vec3(0.920, 1.000, 0.960);  // cœur presque blanc

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    float ease = 1.0 - pow(1.0 - t, 3.0);
    float head = mix(-40.0, iResolution.x + 40.0, ease);   // position horizontale du front
    float env  = (1.0 - t) * (1.0 - t);

    // décalage latéral : interpolation lissée entre deux nœuds aléatoires par bande horizontale
    float frame = mod(floor(iTime * 24.0), 64.0);
    float yb  = fragCoord.y / BAND;
    float k   = floor(yb);
    float f   = fract(yb);
    f = f * f * (3.0 - 2.0 * f);
    float off = mix(hash(k + frame * 13.0), hash(k + 1.0 + frame * 13.0), f) - 0.5;
    float dx  = fragCoord.x - (head + off * AMP);

    float core  = 1.0 - smoothstep(0.0, 1.2, abs(dx));      // trait net
    float halo  = exp(-abs(dx) * 0.12) * 0.5;               // lueur
    // traînée de charge derrière le front
    float trail = fragCoord.x < head ? exp(-(head - fragCoord.x) / 180.0) : 0.0;
    float flick = 0.7 + 0.3 * hash(k + frame * 7.0);

    float a = clamp((core + halo) * flick * MAX_A + trail * 0.06, 0.0, 1.0) * env;
    vec3 col = mix(GREEN, CORE, core);
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

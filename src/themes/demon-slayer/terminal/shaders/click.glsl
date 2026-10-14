// Vague d'eau : au clic (saut de curseur), trois anneaux de vague se déploient du curseur, leurs crêtes
// ondulent irrégulièrement et une écume dorée les marque. Décalés de 0.12 s, effet de 0.45 s.
// Mêmes déclencheurs que click_ripple.glsl : sauts vers la droite uniquement, redessins de zsh ignorés.
const float DURATION = 0.45;                       // secondes (≤ 450 ms)
const float MAX_R    = 26.0;                       // rayon final du premier anneau (px)
const float THICK    = 1.0;                        // demi-épaisseur des traits (px)
const float MIN_JUMP = 3.0;                        // saut minimal en cellules
const vec3  WATER    = vec3(0.353, 0.651, 0.910);  // #5aa6e8, eau
const vec3  FOAM     = vec3(0.949, 0.890, 0.701);  // #f2e3b3, écume

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 col = texture(iChannel0, uv);
    fragColor = col;

    float t = (iTime - iTimeCursorChange) / DURATION;
    float cw = max(iCurrentCursor.z, 1.0), ch = max(iCurrentCursor.w, 1.0);
    vec2 jump = (iCurrentCursor.xy - iPreviousCursor.xy) / vec2(cw, ch);
    if (t < 0.0 || t > 1.0 || abs(jump.y) >= 0.5 || jump.x < MIN_JUMP || iPreviousCursor.x < cw * 3.0) return;

    vec2 center = iCurrentCursor.xy + vec2(cw * 0.5, -ch * 0.5);
    vec2 d = fragCoord - center;
    float r = length(d);
    if (r > MAX_R * 1.3) return;
    float ang = atan(d.y, d.x);

    float wave = 0.0;
    float foam = 0.0;
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float start = fi * 0.12;                   // décalage de chaque anneau (fraction de l'effet)
        float p = clamp((t - start) / (1.0 - start), 0.0, 1.0);
        if (p <= 0.0) continue;
        float reach = mix(3.0, MAX_R * (1.0 - 0.18 * fi), 1.0 - pow(1.0 - p, 3.0));
        float phase = 6.0 * ang + fi * 1.7 + p * 4.0;
        float crest = 1.0 + 0.08 * cos(phase);     // crêtes irrégulières
        float line = 1.0 - smoothstep(THICK - 0.6, THICK + 0.6, abs(r - reach * crest));
        float fade = (1.0 - p) * (1.0 - p) * (1.0 - 0.2 * fi);
        wave += line * fade;
        foam += line * fade * smoothstep(0.6, 1.0, cos(phase));
    }
    wave = clamp(wave * 0.7, 0.0, 1.0);
    foam = clamp(foam * 0.7, 0.0, 1.0);
    vec3 c = mix(col.rgb, WATER, wave);
    c = mix(c, FOAM, foam * 0.6);
    fragColor = vec4(c, col.a);
}

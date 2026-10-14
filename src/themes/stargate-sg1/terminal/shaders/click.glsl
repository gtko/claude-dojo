// Verrouillage de chevron : au clic (saut de curseur), un anneau bleu se resserre sur le curseur
// et une marque orange s'allume au sommet de l'anneau, comme un chevron qui se verrouille. Effet de 0.4 s.
// Mêmes déclencheurs que click_ripple.glsl : sauts vers la droite uniquement, redessins de zsh ignorés.
const float DURATION = 0.40;                       // secondes (≤ 400 ms)
const float RING_R   = 13.0;                       // rayon final de l'anneau (px)
const float STROKE   = 1.1;                        // demi-épaisseur de l'anneau (px)
const float MIN_JUMP = 3.0;                        // saut minimal en cellules
const vec3  RING     = vec3(0.435, 0.827, 0.941);  // #6fd3f0
const vec3  CHEVRON  = vec3(0.878, 0.659, 0.290);  // #e0a84a, marque orange

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

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
    if (r > RING_R * 2.5) return;

    // verrouillage : l'anneau part à 2× son rayon et se resserre pendant les 60 % premiers de l'effet
    float snap  = 1.0 - pow(1.0 - min(t / 0.6, 1.0), 3.0);
    float ringR = RING_R * mix(2.0, 1.0, snap);
    float ringA = 1.0 - smoothstep(STROKE - 0.5, STROKE + 0.5, abs(r - ringR));
    float fade  = 1.0 - smoothstep(0.55, 1.0, t);

    // marque orange : un chevron au sommet de l'anneau, allumé pendant le verrouillage
    vec2 A = vec2(-3.6, ringR - 0.8), B = vec2(0.0, ringR + 2.8), C = vec2(3.6, ringR - 0.8);
    float dv = min(sdSegment(d, A, B), sdSegment(d, B, C));
    float mark = (1.0 - smoothstep(0.7, 1.5, dv))
               * smoothstep(0.25, 0.4, t) * (1.0 - smoothstep(0.7, 1.0, t));

    vec3 c = mix(col.rgb, RING, ringA * fade * 0.55);
    c = mix(c, CHEVRON, mark * 0.85);
    fragColor = vec4(c, col.a);
}

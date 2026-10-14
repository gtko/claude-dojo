// Traînée d'énergie occulte : à chaque saut du curseur, un sillage noir-violet ondule de l'ancienne à la
// nouvelle position et se dissout en 0.22 s. Cœur sombre, liseré violet : lisible sur fond sombre, texte intact.
// Mêmes déclencheurs que la traînée de référence : pas de sillage en frappe normale ni au redessin zsh.
const float DURATION = 0.22;                       // secondes
const float OPACITY  = 0.55;
const vec3  VIOLET   = vec3(0.690, 0.424, 1.000);  // #b06cff
const vec3  VOID     = vec3(0.060, 0.020, 0.100);  // noir violacé

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    fragColor = base;

    // xy = coin haut-gauche (origine en bas), zw = taille
    vec2 cur  = iCurrentCursor.xy  + vec2(iCurrentCursor.z,  -iCurrentCursor.w)  * 0.5;
    vec2 prev = iPreviousCursor.xy + vec2(iPreviousCursor.z, -iPreviousCursor.w) * 0.5;

    float lineH   = max(iCurrentCursor.w, 1.0);
    float jumpLen = distance(cur, prev);
    if (jumpLen < lineH * 1.5) return;               // pas de sillage en frappe normale
    if (abs(cur.y - prev.y) < lineH * 0.5) return;   // même ligne : redessin zsh

    float t = clamp((iTime - iTimeCursorChange) / DURATION, 0.0, 1.0);
    if (t >= 1.0) return;

    vec2 dir = (cur - prev) / jumpLen;
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 rel = fragCoord - prev;
    float along  = dot(rel, dir) / jumpLen;          // 0 à la queue, 1 à la tête
    float across = dot(rel, nrm);

    // la queue se rétracte vers la tête : le sillage se dissout
    float tailS = smoothstep(0.0, 0.7, t);
    if (along < tailS || along > 1.0) return;
    float local = (along - tailS) / max(1.0 - tailS, 1e-3);

    // ondulation qui file le long du sillage
    float wob  = sin(dot(rel, dir) * 0.35 - iTime * 38.0) * lineH * 0.22;
    float d    = abs(across - wob);
    float halfW = lineH * mix(0.05, 0.30, local);
    float shape = 1.0 - smoothstep(halfW - 1.0, halfW + 1.0, d);
    vec3 col = mix(VOID, VIOLET, smoothstep(halfW * 0.4, halfW, d));   // cœur noir, liseré violet
    float fade = (1.0 - t) * (1.0 - t);
    float a = shape * fade * mix(0.3, 1.0, local) * OPACITY;
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

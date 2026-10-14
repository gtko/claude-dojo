// Fissure maudite : à chaque clic (saut du curseur, mêmes déclencheurs que click_ripple), six fissures violettes
// se propagent depuis le curseur comme un verre qui casse, avec un éclat rose-violet au centre (0.4 s).
// Traits fins, opacité modérée : le texte n'est jamais masqué.
const float DURATION = 0.40;                          // secondes
const float MAX_LEN  = 70.0;                          // longueur finale d'une fissure (px)
const float MIN_JUMP = 3.0;                           // saut minimal en cellules
const int   CRACKS   = 6;
const float TAU      = 6.2831853;
const vec3  VIOLET   = vec3(0.690, 0.424, 1.000);     // #b06cff
const vec3  PINK     = vec3(0.886, 0.227, 0.306);     // #e23a4e
const vec3  CORE     = vec3(0.960, 0.920, 1.000);     // cœur presque blanc

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 col = texture(iChannel0, fragCoord / iResolution.xy);
    float cw = max(iCurrentCursor.z, 1.0), ch = max(iCurrentCursor.w, 1.0);
    vec2 jump = (iCurrentCursor.xy - iPreviousCursor.xy) / vec2(cw, ch);
    float t = (iTime - iTimeCursorChange) / DURATION;
    if (t < 0.0 || t > 1.0 || abs(jump.y) >= 0.5 || jump.x < MIN_JUMP || iPreviousCursor.x < cw * 3.0) {
        fragColor = col;
        return;
    }

    vec2 c = iCurrentCursor.xy + vec2(cw * 0.5, -ch * 0.5);
    vec2 d = fragCoord - c;
    float dist = length(d);
    if (dist > MAX_LEN + 6.0) { fragColor = col; return; }   // hors zone d'effet

    float ease = 1.0 - pow(1.0 - t, 3.0);
    float fade = (1.0 - t) * (1.0 - t);
    float seed = fract(iTimeCursorChange * 0.731) * 97.0;

    // fissures : chacune en trois segments dont les sommets dévient au hasard
    float cracks = 0.0;
    for (int i = 0; i < CRACKS; i++) {
        float fi  = float(i);
        float ang = fi * TAU / float(CRACKS) + (hash(seed + fi) - 0.5) * 0.7;
        vec2 dir = vec2(cos(ang), sin(ang));
        vec2 nrm = vec2(-dir.y, dir.x);
        float L = MAX_LEN * ease * (0.6 + 0.4 * hash(seed + fi + 9.0));
        vec2 p0 = c + dir * 4.0;
        vec2 p1 = c + dir * (L * 0.35) + nrm * (hash(seed + fi + 21.0) - 0.5) * L * 0.18;
        vec2 p2 = c + dir * (L * 0.70) + nrm * (hash(seed + fi + 33.0) - 0.5) * L * 0.22;
        vec2 p3 = c + dir * L;
        float ds = min(min(sdSegment(fragCoord, p0, p1), sdSegment(fragCoord, p1, p2)),
                       sdSegment(fragCoord, p2, p3));
        cracks = max(cracks, (1.0 - smoothstep(0.0, 1.0, ds)) + 0.25 * exp(-ds * 0.6));
    }
    cracks = clamp(cracks, 0.0, 1.0) * fade;

    // éclat central très bref, rose-violet
    float flash = exp(-dist * 0.18) * (1.0 - smoothstep(0.0, 0.3, t));
    vec3 crackCol = mix(VIOLET, CORE, smoothstep(0.7, 1.0, cracks));
    vec3 hit = mix(crackCol, mix(PINK, VIOLET, 0.5), clamp(flash, 0.0, 1.0));
    float a = clamp(cracks * 0.7 + flash * 0.5, 0.0, 1.0);
    fragColor = vec4(mix(col.rgb, hit, a), col.a);
}

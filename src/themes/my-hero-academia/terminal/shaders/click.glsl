// Impact « SMASH » : à chaque clic (saut du curseur, mêmes déclencheurs que click_ripple), une onde de choc
// verte se dilate autour du curseur, huit éclairs jaillissent et un éclat jaune s'éteint en 0.35 s.
// Trait fin, opacité faible : le texte n'est jamais masqué.
const float DURATION = 0.35;                       // secondes
const float MAX_R    = 46.0;                       // rayon final de l'onde (px)
const float STRENGTH = 0.70;                       // opacité maximale
const float MIN_JUMP = 3.0;                        // saut minimal en cellules
const int   SPARKS   = 8;
const vec3  GREEN    = vec3(0.235, 0.961, 0.604);  // #3cf59a
const vec3  YELLOW   = vec3(1.000, 0.839, 0.039);  // #ffd60a
const float TAU      = 6.2831853;

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
    if (dist > MAX_R + 14.0) { fragColor = col; return; }   // hors zone d'effet

    float ease = 1.0 - pow(1.0 - t, 3.0);
    float fade = (1.0 - t) * (1.0 - t);
    float seed = fract(iTimeCursorChange * 0.731) * 97.0;

    // onde de choc : anneau fin qui s'élargit
    float r    = mix(4.0, MAX_R, ease);
    float ring = (1.0 - smoothstep(0.0, 1.6, abs(dist - r))) * fade;

    // éclairs : segments brisés qui partent du centre, direction et longueur aléatoires
    float spark = 0.0;
    for (int i = 0; i < SPARKS; i++) {
        float fi  = float(i);
        float ang = fi * TAU / float(SPARKS) + (hash(seed + fi) - 0.5) * 0.6;
        vec2 dir = vec2(cos(ang), sin(ang));
        vec2 nrm = vec2(-dir.y, dir.x);
        float len = mix(6.0, 26.0, ease) * (0.5 + 0.5 * hash(seed + fi + 20.0));
        vec2 p0 = c + dir * 4.0;
        vec2 pm = c + dir * (len * 0.5) + nrm * (hash(seed + fi + 40.0) - 0.5) * len * 0.5;
        vec2 p1 = c + dir * len;
        float ds = min(sdSegment(fragCoord, p0, pm), sdSegment(fragCoord, pm, p1));
        spark = max(spark, 1.0 - smoothstep(0.0, 1.0, ds));
    }
    spark *= fade;

    // éclat central très bref, qui vire du jaune au vert
    float flash = exp(-dist * 0.2) * (1.0 - smoothstep(0.0, 0.25, t));
    vec3 hit = mix(GREEN, YELLOW, clamp(flash, 0.0, 1.0));
    float a = clamp(ring * 0.6 + spark * 0.5 + flash * 0.6, 0.0, 1.0) * STRENGTH;
    fragColor = vec4(mix(col.rgb, hit, a), col.a);
}

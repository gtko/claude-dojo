// Eclat de boussole au saut du curseur (clic, Ctrl+A/E...) : une rose des vents doree s'ouvre
// sur place, pivote doucement et s'eteint en 0.45 s. Memes declencheurs que le shuriken de la base.
const float DURATION = 0.45;                       // secondes
const float SIZE     = 12.0;                       // demi-taille finale (px)
const float MIN_JUMP = 3.0;                        // saut minimal en cellules
const float MAX_A    = 0.85;
const float PI       = 3.1415927;
const vec3  GOLD     = vec3(0.969, 0.839, 0.439);  // #f7d670
const vec3  CREAM    = vec3(0.957, 0.945, 0.902);  // #f4f1e6

// Rose des vents : negatif a l'interieur. Pointes longues sur les axes, courtes sur les diagonales.
float rose(vec2 p) {
    float r = length(p);
    float a = atan(p.y, p.x);
    float axes  = pow(abs(cos(2.0 * a)), 36.0);
    float diags = pow(abs(sin(2.0 * a)), 36.0);
    return r - (0.16 + 0.84 * axes + 0.38 * diags);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
    float t = (iTime - iTimeCursorChange) / DURATION;
    vec2 cell = vec2(max(iCurrentCursor.z, 1.0), max(iCurrentCursor.w, 1.0));
    vec2 jump = (iCurrentCursor.xy - iPreviousCursor.xy) / cell;
    if (t < 0.0 || t > 1.0 || abs(jump.y) >= 0.5 || jump.x < MIN_JUMP || iPreviousCursor.x < cell.x * 3.0) {
        fragColor = base;
        return;
    }

    vec2 center = iCurrentCursor.xy + vec2(cell.x * 0.5, -cell.y * 0.5);
    vec2 d = fragCoord - center;
    float sz = SIZE * mix(0.4, 1.0, 1.0 - pow(1.0 - t, 3.0));   // la rose s'ouvre
    float wobble = sin(t * PI) * 0.25;                          // leger pivot de l'aiguille
    float c = cos(wobble), s = sin(wobble);
    vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / sz;

    float v = rose(q) * sz;                        // distance approximative en px
    float fill = 1.0 - smoothstep(-0.6, 0.6, v);
    float cr = length(d) / (sz * 0.12);
    float core = exp(-cr * cr);                    // eclat central
    vec3 col = mix(GOLD, CREAM, core);

    float a = fill * (1.0 - smoothstep(0.5, 1.0, t)) * MAX_A;
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

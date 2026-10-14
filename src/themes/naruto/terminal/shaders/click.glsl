// Shuriken on click / completion: an orange shuriken spins in place at the cursor
// and vanishes in 0.4 s. Triggered by cursor jumps.
// zsh redraws the line on every key: jumps to the left and jumps starting at line start are ignored.
const float DURATION = 0.40;                       // seconds (<= 400 ms)
const float SIZE     = 11.0;                       // final half-size (px)
const float SPINS    = 1.25;                       // full turns during the effect
const float MIN_JUMP = 3.0;                        // minimal jump, in cells
const vec3  ORANGE   = vec3(0.949, 0.549, 0.157);  // #f28c28
const vec3  CREAM    = vec3(0.965, 0.941, 0.878);  // #f6f0e0
const float TAU      = 6.2831853;

// Astroid (|x|^(2/3) + |y|^(2/3))^(3/2) = 1: four points on the axes, concave edges = shuriken
float shuriken(vec2 p) {
    vec2 q = abs(p);
    return pow(pow(q.x, 0.6667) + pow(q.y, 0.6667), 1.5);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 col = texture(iChannel0, uv);
    float t = (iTime - iTimeCursorChange) / DURATION;
    vec2 jump = (iCurrentCursor.xy - iPreviousCursor.xy) / vec2(max(iCurrentCursor.z, 1.0), max(iCurrentCursor.w, 1.0));
    float cw = max(iCurrentCursor.z, 1.0), ch = max(iCurrentCursor.w, 1.0);
    if (t < 0.0 || t > 1.0 || abs(jump.y) >= 0.5 || jump.x < MIN_JUMP || iPreviousCursor.x < cw * 3.0) { fragColor = col; return; }

    vec2 center = iCurrentCursor.xy + vec2(cw * 0.5, -ch * 0.5);
    vec2 d = fragCoord - center;
    float ease = 1.0 - pow(1.0 - t, 2.0);
    float size = SIZE * mix(0.5, 1.0, ease);
    float ang = t * SPINS * TAU;
    float c = cos(ang), s = sin(ang);
    vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / size;   // rotate, then scale

    float v = shuriken(q);                                  // < 1 inside, = 1 on the outline
    float body = 1.0 - smoothstep(0.96, 1.0, v);
    float rim  = smoothstep(0.78, 0.96, v) * body;          // light edge
    vec3 sh = mix(ORANGE, CREAM, rim * 0.6);
    float fade = 1.0 - smoothstep(0.5, 1.0, t);
    float a = body * fade * 0.85;
    fragColor = vec4(mix(col.rgb, sh, a), col.a);
}

// Cercle magique au saut du curseur (clic, Ctrl+A/E...) : un cercle de runes lavande et or
// s'ouvre autour du curseur, tourne lentement et s'efface en 0.6 s. Traits fins, texte intact.
// Declencheurs identiques au shuriken de la base : sauts vers la droite, pas de redessin zsh.
const float DURATION = 0.60;                       // secondes
const float RADIUS   = 22.0;                       // rayon final (px)
const float MIN_JUMP = 3.0;                        // saut minimal en cellules
const float SPIN     = 1.5;                        // rotation (rad/s)
const float MAX_A    = 0.55;
const float PI       = 3.1415927;
const float TAU      = 6.2831853;
const vec3  RING     = vec3(0.722, 0.604, 0.839);  // #b89ad6
const vec3  RUNE     = vec3(0.941, 0.843, 0.557);  // #f0d78e

float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(pa - ba * h);
}

float hash(float n) { return fract(sin(n) * 43758.5453); }

// trait fin : 1 sur le trait, 0 a environ 1 px de distance
float stroke(float dist) { return 1.0 - smoothstep(0.35, 1.2, dist); }

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
    float r = RADIUS * mix(0.55, 1.0, 1.0 - pow(1.0 - t, 3.0));   // le cercle s'ouvre
    float ang = (iTime - iTimeCursorChange) * SPIN;

    float intro = smoothstep(0.0, 0.2, t);
    float fade = 1.0 - smoothstep(0.5, 1.0, t);
    float k = intro * fade * MAX_A;

    float dr = length(d);
    float rings = max(stroke(abs(dr - r)), max(stroke(abs(dr - r * 0.84)), stroke(abs(dr - r * 0.30))));

    // runes : un trait radial par case, avec un glyphe (barre) sur une case sur deux
    float runes = 0.0;
    for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float th = fi * TAU / 12.0 + ang;
        vec2 dir = vec2(cos(th), sin(th));
        vec2 tang = vec2(-dir.y, dir.x);
        runes = max(runes, stroke(sdSegment(d, dir * r * 0.86, dir * r * 0.98)));
        if (hash(fi + 1.0) > 0.5) {
            vec2 mid = dir * r * 0.93;
            runes = max(runes, stroke(sdSegment(d, mid - tang * r * 0.06, mid + tang * r * 0.06)));
        }
    }

    // hexagramme inscrit : deux triangles
    float star = 0.0;
    for (int i = 0; i < 3; i++) {
        float a1 = ang + float(i) * TAU / 3.0;
        float a2 = a1 + TAU / 3.0;
        vec2 p1 = vec2(cos(a1), sin(a1)) * r * 0.72;
        vec2 p2 = vec2(cos(a2), sin(a2)) * r * 0.72;
        star = max(star, stroke(sdSegment(d, p1, p2)));
        float b1 = a1 + PI / 3.0;
        float b2 = b1 + TAU / 3.0;
        vec2 q1 = vec2(cos(b1), sin(b1)) * r * 0.72;
        vec2 q2 = vec2(cos(b2), sin(b2)) * r * 0.72;
        star = max(star, stroke(sdSegment(d, q1, q2)));
    }

    vec3 rgb = mix(base.rgb, RING, rings * k);
    rgb = mix(rgb, RUNE, max(runes, star) * k);
    fragColor = vec4(rgb, base.a);
}

// Petales au retour du focus : une quinzaine de petales lavande tombent en se balancant
// et tournoient, puis disparaissent en 1.6 s. Faible opacite : le texte reste lisible.
const float DURATION = 1.6;                        // secondes
const int   COUNT    = 14;
const float MAX_A    = 0.30;
const float TAU      = 6.2831853;
const vec3  PETAL_A  = vec3(0.945, 0.851, 0.941);  // #f1d9f0
const vec3  PETAL_B  = vec3(0.722, 0.604, 0.839);  // #b89ad6

float hash(float n) { return fract(sin(n) * 43758.5453); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 res = iResolution.xy;
    vec4 base = texture(iChannel0, fragCoord / res);
    float t = iTime - iTimeFocus;
    if (iFocus == 0 || t < 0.0 || t > DURATION) { fragColor = base; return; }

    vec3 rgb = base.rgb;
    for (int i = 0; i < COUNT; i++) {
        float fi = float(i) + 1.0;
        float h1 = hash(fi * 12.9898);
        float h2 = hash(fi * 78.233);
        float h3 = hash(fi * 37.719);
        float h4 = hash(fi * 91.337);
        float h5 = hash(fi * 53.771);
        float delay = h1 * 0.5;                    // departs echelonnes
        float life = DURATION - delay;
        float tau = t - delay;
        if (tau < 0.0) continue;
        float p = tau / life;
        if (p >= 1.0) continue;

        float y = res.y * (1.06 - 1.12 * p);       // chute (origine en bas)
        float x = res.x * h2 + sin(tau * 2.2 + h3 * TAU) * 22.0;   // balancement
        vec2 pos = vec2(x, y);
        float ang = tau * (1.5 + 2.0 * h4) + h5 * TAU;             // rotation propre
        float c = cos(ang), s = sin(ang);
        vec2 d = fragCoord - pos;
        vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
        vec2 ab = vec2(4.5 + 3.0 * h4, 2.4 + 1.2 * h5);            // demi-axes (px)
        float e = length(q / ab);
        float m = 1.0 - smoothstep(0.85, 1.0, e);
        float fadeIn = sin(p * 3.14159);           // apparition et disparition douces
        vec3 col = mix(PETAL_A, PETAL_B, h3);
        rgb = mix(rgb, col, m * fadeIn * MAX_A);
    }
    fragColor = vec4(rgb, base.a);
}

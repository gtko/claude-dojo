// Halo de mana : les parties claires du texte diffusent une lueur lavande tres douce,
// qui respire lentement. Douze echantillons seulement, pour rester leger.
const int   TAPS      = 12;
const float RADIUS    = 4.0;                       // px ecran
const float THRESHOLD = 0.6;
const float STRENGTH  = 0.18;
const vec3  HALO_A    = vec3(0.722, 0.604, 0.839); // #b89ad6
const vec3  HALO_B    = vec3(0.663, 0.816, 0.961); // #a9d0f5

vec3 brightPart(vec2 uv) {
    vec3 c = texture(iChannel0, uv).rgb;
    float hi = max(c.r, max(c.g, c.b));
    return c * smoothstep(THRESHOLD, 1.0, hi);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 px = 1.0 / iResolution.xy;
    vec4 base = texture(iChannel0, fragCoord * px);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996323;                  // angle d'or
        float r = RADIUS * 2.0 * sqrt(fi / float(TAPS));
        float w = exp(-(r * r) / (2.0 * RADIUS * RADIUS));
        acc += brightPart((fragCoord + vec2(cos(a), sin(a)) * r) * px) * w;
        wsum += w;
    }
    vec3 tint = mix(HALO_A, HALO_B, 0.5 + 0.5 * sin(iTime * 0.3));
    float breath = 0.85 + 0.15 * sin(iTime * 0.9);
    vec3 halo = (acc / wsum) * tint * 1.4;
    fragColor = vec4(base.rgb + halo * STRENGTH * breath, base.a);
}

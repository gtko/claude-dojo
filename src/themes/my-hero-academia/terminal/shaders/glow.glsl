// Halo vert discret : les parties vives du texte diffusent une lueur verte très douce (style One For All).
// Douze échantillons seulement pour rester léger ; intensité faible, la lisibilité prime.
const float THRESHOLD = 0.50;
const float STRENGTH  = 0.20;
const float RADIUS    = 5.0;                        // px écran
const int   TAPS      = 12;
const vec3  GREEN     = vec3(0.235, 0.961, 0.604);  // #3cf59a

vec3 brightPart(vec2 uv) {
    vec3 c = texture(iChannel0, uv).rgb;
    float hi = max(c.r, max(c.g, c.b));
    return c * smoothstep(THRESHOLD, 1.0, hi);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 px = 1.0 / iResolution.xy;
    vec2 uv = fragCoord * px;
    vec4 base = texture(iChannel0, uv);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float a = fi * 2.39996323;                       // angle d'or
        float r = RADIUS * 2.0 * sqrt(fi / float(TAPS));
        float w = exp(-(r * r) / (2.0 * RADIUS * RADIUS));
        acc += brightPart((fragCoord + vec2(cos(a), sin(a)) * r) * px) * w;
        wsum += w;
    }
    vec3 halo = (acc / wsum) * GREEN;
    fragColor = vec4(base.rgb + halo * STRENGTH, base.a);
}

// Halo de l'horizon des événements : une lueur bleutée très discrète, nulle au centre et plus forte
// sur les bords de la fenêtre, avec un anneau fin qui respire lentement. Le texte reste au centre.
const float STRENGTH = 0.12;                       // intensité maximale sur les bords
const vec3  HORIZON  = vec3(0.435, 0.827, 0.941);  // #6fd3f0

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);

    // q : -1..1 au milieu des bords, environ 1.4 dans les coins
    vec2 q = (uv - 0.5) * 2.0;
    float r = length(q);
    float edge = smoothstep(0.55, 1.2, r);            // lueur qui monte vers les bords
    float e = (r - 0.98) / 0.06;
    float ring = exp(-e * e);                         // anneau de l'horizon
    float breath = 0.8 + 0.2 * sin(iTime * 0.9);
    float amount = STRENGTH * (0.7 * edge + 0.5 * ring) * breath;
    fragColor = vec4(mix(base.rgb, HORIZON, amount), base.a);
}

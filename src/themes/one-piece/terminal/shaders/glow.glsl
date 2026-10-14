// Halo marin : une lumiere turquoise filtree par l'eau descend du haut de l'ecran, traversee
// de reflets (caustiques) qui ondulent tres lentement. Opacite maximale 6 %, texte intact.
const float STRENGTH = 0.06;
const vec3  SEA      = vec3(0.310, 0.820, 0.773);  // #4fd1c5

float ridge(float x) { return 1.0 - abs(sin(x)); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    vec2 q = fragCoord / 110.0;
    float t = iTime * 0.3;
    float c1 = ridge(q.x * 2.1 + sin(q.y * 1.7 + t) * 1.3 + t * 0.6);
    float c2 = ridge(q.y * 2.5 + sin(q.x * 1.3 - t * 1.1) * 1.1 - t * 0.5);
    float caustic = pow(c1 * c2, 6.0);
    float light = smoothstep(0.4, 1.0, uv.y) * (0.45 + 0.55 * caustic);
    vec3 rgb = mix(base.rgb, SEA, light * STRENGTH);
    fragColor = vec4(rgb, base.a);
}

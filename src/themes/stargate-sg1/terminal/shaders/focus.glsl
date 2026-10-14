// Kawoosh : au retour du focus, une nappe d'énergie bleutée jaillit de l'anneau et s'élargit
// en ellipse (perspective de la porte), puis se dissipe en 0.6 s. Faible opacité : le texte reste lisible.
const float DURATION = 0.60;                       // secondes
const float MAX_R    = 340.0;                      // rayon horizontal final (px)
const float ASPECT   = 0.42;                       // aplatissement vertical de l'ellipse
const float MAX_A    = 0.20;                       // opacité maximale
const vec3  WATER    = vec3(0.435, 0.827, 0.941);  // #6fd3f0
const vec3  FLASH    = vec3(0.831, 0.902, 0.973);  // #d4e6f8, éclat du front

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 3; i++) { v += amp * vnoise(p); p *= 2.02; amp *= 0.5; }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    // distance normalisée à l'ellipse centrale (égale au rayon sur l'axe horizontal)
    vec2 d = fragCoord - iResolution.xy * 0.5;
    float dist = length(vec2(d.x, d.y / ASPECT));
    float ease = 1.0 - pow(1.0 - t, 3.0);
    float r = mix(40.0, MAX_R, ease);
    // le bruit déforme le front : la nappe ondule au lieu d'être un cercle net
    float n = fbm(fragCoord / 70.0 + vec2(t * 2.0, -t));
    float edge = r * (0.85 + 0.3 * n);
    float q = (dist - edge) / 12.0;
    float front = exp(-q * q);                                        // crête lumineuse du front
    float body = (1.0 - smoothstep(edge * 0.3, edge, dist)) * 0.4;   // remplissage derrière le front
    float fade = (1.0 - t) * (1.0 - t);
    float a = clamp((front + body) * fade * MAX_A * (0.7 + 0.6 * n), 0.0, 1.0);
    vec3 col = mix(WATER, FLASH, front * (1.0 - t));
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

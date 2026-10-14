// Éclair de lame : au retour du focus, un trait diagonal doré traverse la fenêtre d'un seul geste
// (0.35 s) et laisse une rémanence violette. Opacité faible : le texte reste lisible.
const float DURATION = 0.35;                       // secondes
const float MAX_A    = 0.40;                       // opacité maximale du tranchant
const vec3  STEEL    = vec3(0.949, 0.890, 0.701);  // #f2e3b3, lame claire
const vec3  VIOLET   = vec3(0.725, 0.635, 0.925);  // #b9a2ec, rémanence

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    vec2 dir = normalize(vec2(1.0, -0.55));       // sens de la lame
    vec2 nrm = vec2(-dir.y, dir.x);               // normale : distance à l'axe de la lame
    vec2 c = fragCoord - iResolution.xy * 0.5;
    float s = dot(c, nrm);
    float reach = length(iResolution.xy) * 0.5;
    float ease = 1.0 - pow(1.0 - t, 3.0);
    float pos = mix(-reach, reach, ease);         // position de la lame, qui balaie l'écran
    float along = abs(dot(c, dir)) / reach;
    float taper = 1.0 - smoothstep(0.55, 1.0, along);   // tranchant effilé aux extrémités

    float e0 = (s - pos) / 1.1;
    float core = exp(-e0 * e0);
    float e1 = (s - pos) / 7.0;
    float glow = exp(-e1 * e1);
    float e2 = (s - (pos - 22.0)) / 1.0;          // rémanence, derrière la lame
    float echo = exp(-e2 * e2) * 0.5;
    float fade = (1.0 - t) * (1.0 - t);
    float a = clamp((core * 0.9 + glow * 0.22 + echo) * taper * fade * MAX_A, 0.0, 1.0);
    vec3 col = mix(VIOLET, STEEL, core);
    fragColor = vec4(mix(base.rgb, col, a), base.a);
}

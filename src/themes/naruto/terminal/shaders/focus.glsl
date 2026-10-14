// Jutsu poof: on focus gain, a grey-white smoke puff expands from the screen centre
// and dissipates in 0.5 s. Low opacity keeps the text readable.
const float DURATION = 0.50;                   // seconds
const float MAX_R    = 260.0;                  // final puff radius (px)
const float MAX_A    = 0.16;                   // peak opacity
const vec3  SMOKE    = vec3(0.86, 0.87, 0.90); // grey-white

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
    for (int i = 0; i < 4; i++) { v += amp * vnoise(p); p *= 2.02; amp *= 0.5; }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);
    float t = (iTime - iTimeFocus) / DURATION;
    if (iFocus == 0 || t < 0.0 || t > 1.0) { fragColor = base; return; }

    vec2 center = iResolution.xy * 0.5;
    float dist = length(fragCoord - center);
    float ease = 1.0 - pow(1.0 - t, 3.0);
    float r = mix(30.0, MAX_R, ease);
    // ragged edge: noise distorts the radius and makes the smoke swirl
    float n = fbm(fragCoord / 55.0 + vec2(t * 1.5, -t));
    float edge = r * (0.75 + 0.5 * n);
    float body = 1.0 - smoothstep(edge * 0.55, edge, dist);
    float fade = (1.0 - t) * (1.0 - t);
    float a = clamp(body * fade * MAX_A * (0.6 + 0.8 * n), 0.0, 1.0);
    fragColor = vec4(mix(base.rgb, SMOKE, a), base.a);
}

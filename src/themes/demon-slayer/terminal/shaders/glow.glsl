// Souffle du soleil : lueur chaude et très discrète au pied de la fenêtre (près du prompt), qui s'estompe
// vers le haut et respire lentement. La teinte reste faible : la lisibilité du texte prime.
const float STRENGTH = 0.10;                       // intensité au centre du bas
const vec3  SUN_LOW  = vec3(0.910, 0.443, 0.290);  // #e8714a
const vec3  SUN_HOT  = vec3(0.949, 0.890, 0.701);  // #f2e3b3

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 base = texture(iChannel0, uv);

    // ellipse ancrée au milieu du bas, plus haute que large
    vec2 q = (uv - vec2(0.5, 0.0)) * vec2(1.4, 2.2);
    float g = exp(-dot(q, q) * 1.6);
    float breath = 0.85 + 0.15 * sin(iTime * 0.7);
    float amount = STRENGTH * g * breath;
    vec3 col = mix(SUN_LOW, SUN_HOT, g * g);
    fragColor = vec4(mix(base.rgb, col, amount), base.a);
}

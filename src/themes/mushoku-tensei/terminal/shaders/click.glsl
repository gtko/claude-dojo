// Spell flash: on click or completion (cursor jump), a cyan ring expands from the cursor
// and turns gold as it grows, with eight short rays and a faint core. Gone in 0.35 s.
// Same trigger rules as the naruto click shader: zsh line redraws are ignored.
const float DURATION  = 0.35;                       // seconds
const float MIN_JUMP  = 3.0;                        // minimal jump, in cells
const int   RAYS      = 8;
const float OPACITY   = 0.60;
const float TAU       = 6.2831853;
const vec3  MANA_CYAN = vec3(0.373, 0.863, 0.925);  // #5fdcec
const vec3  GOLD      = vec3(0.965, 0.851, 0.557);  // #f6d98e
const vec3  CORE      = vec3(0.902, 0.965, 0.945);  // pale mana

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec4 col = texture(iChannel0, fragCoord / iResolution.xy);
    float t = (iTime - iTimeCursorChange) / DURATION;
    float cw = max(iCurrentCursor.z, 1.0), ch = max(iCurrentCursor.w, 1.0);
    vec2 jump = (iCurrentCursor.xy - iPreviousCursor.xy) / vec2(cw, ch);
    if (t < 0.0 || t > 1.0 || abs(jump.y) >= 0.5 || jump.x < MIN_JUMP || iPreviousCursor.x < cw * 3.0) {
        fragColor = col;
        return;
    }

    vec2 center = iCurrentCursor.xy + vec2(cw * 0.5, -ch * 0.5);
    vec2 d = fragCoord - center;
    float dist = length(d);
    float ease = 1.0 - pow(1.0 - t, 3.0);
    float fade = (1.0 - t) * (1.0 - t);

    // expanding ring, cyan turning gold
    float R = mix(0.6, 2.4, ease) * ch;
    float ring = 1.0 - smoothstep(0.6, 1.6, abs(dist - R));

    // rays: angular distance to the nearest ray axis, converted to pixels
    float ang = atan(d.y, d.x + 1e-6);               // avoid atan(0, 0) at the exact centre
    float sector = TAU / float(RAYS);
    float f = abs(fract(ang / sector + 0.5) - 0.5);   // 0 on a ray, 0.5 between two rays
    float perp = dist * f * sector;
    float rayLen = mix(0.8, 2.6, ease) * ch;
    float rays = (1.0 - smoothstep(0.5, 1.3, perp)) * step(dist, rayLen) * step(0.4 * ch, dist);

    // faint core at the cursor
    float core = exp(-dist * dist / (ch * ch * 0.18));

    vec3 rgb = col.rgb;
    rgb = mix(rgb, mix(MANA_CYAN, GOLD, ease), ring * fade * OPACITY);
    rgb = mix(rgb, GOLD, rays * fade * OPACITY);
    rgb = mix(rgb, CORE, core * fade * OPACITY * 0.5);
    fragColor = vec4(rgb, col.a);
}

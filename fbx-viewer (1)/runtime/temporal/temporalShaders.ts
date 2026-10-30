/**
 * The resolve and the output of temporal anti-aliasing.
 *
 * Colour is gathered with its highlights compressed (each colour over one plus its brightest channel), so a
 * single very bright pixel weighs no more than its neighbours and filtering cannot ring around it. History
 * stays compressed; the output pass expands it for the HDR effects that follow.
 *
 * History holds two pictures: the colour and how much sample weight it has gathered, and beside it the two things
 * that decide how far to trust it:
 *  - The farthest surface around this pixel last frame. A surface further away than all of them was behind
 *    something, and has no history of its own here, whatever colour lies there, so that history is dropped.
 *    The farthest, not the pixel's own: a thin line hit on one frame must not look as if it hid what is
 *    behind it, least of all at a small render scale, where one drawn pixel covers several output pixels.
 *  - How much contrast this pixel's surroundings have shown lately at an edge in depth. A line thinner than a
 *    pixel is only hit on some of the jittered frames; on the others the colours around it say it is not
 *    there, and clipping to them alone would wipe it, then bring it back: the flicker this is here to remove.
 *    The remembered contrast keeps the box wide enough through those frames, and fades over one cycle of
 *    jitter. Only geometry holding still on screen earns it: a moving shadow has no edge in depth, and nothing
 *    is remembered of a moving object or a silhouette sliding by, so none of them hold the box open behind them.
 */

const COMPRESSION = /* glsl */ `
vec3 compressColour( vec3 c ) { return c / ( 1.0 + max( c.r, max( c.g, c.b ) ) ); }
vec3 expandColour( vec3 c ) { return c / max( 1.0 - max( c.r, max( c.g, c.b ) ), 1e-3 ); }
`;

/** Keeps the scene's depth: the passes that follow draw into the buffer it belongs to, and clear it. */
export const DEPTH_COPY_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
layout( location = 0 ) out vec4 copied;
uniform sampler2D depthMap;
void main() {
    copied = vec4( texelFetch( depthMap, ivec2( gl_FragCoord.xy ), 0 ).r, 0.0, 0.0, 1.0 );
}`;

export const RESOLVE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
layout( location = 0 ) out vec4 resolved;
layout( location = 1 ) out vec4 companion;
in vec2 vUv;
uniform sampler2D current;
uniform sampler2D depthMap;
uniform sampler2D objectVelocity;
uniform sampler2D history;
/** r: the contrast remembered around each pixel; g: how far away the farthest surface around it stood. */
uniform sampler2D companionHistory;
uniform vec2 inputSize;
uniform vec2 outputSize;
/** The offset of this frame's samples, in drawn pixels. */
uniform vec2 jitter;
/** From this frame's clip space, jitter left out, to the last frame's. */
uniform mat4 reprojection;
uniform float hasHistory;
/** The newest frame's least share once a pixel has settled: at rest and in motion. */
uniform vec2 blendFloor;
/** How much of the colour box, in standard deviations, history may stay inside: at rest and in motion. */
uniform vec2 clipSpread;
/** What remembered contrast keeps of itself each frame. */
uniform float contrastFade;
/** From depth to distance along the view: A and B of B / ( z + A ); the third turns the distance test on. */
uniform vec3 depthToDistance;
${COMPRESSION}

vec3 toYCoCg( vec3 c ) {
    return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 fromYCoCg( vec3 c ) {
    return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z );
}

/** Five bilinear taps standing in for a sixteen-tap Catmull-Rom filter, which keeps history from softening. */
vec3 sampleHistory( vec2 uv ) {
    vec2 texel = 1.0 / outputSize;
    vec2 position = uv * outputSize;
    vec2 centre = floor( position - 0.5 ) + 0.5;
    vec2 f = position - centre;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = -0.5 * f3 + f2 - 0.5 * f;
    vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
    vec2 w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
    vec2 w3 = 0.5 * f3 - 0.5 * f2;
    vec2 w12 = w1 + w2;
    vec2 tc12 = ( centre + w2 / w12 ) * texel;
    vec2 tc0 = ( centre - 1.0 ) * texel;
    vec2 tc3 = ( centre + 2.0 ) * texel;
    vec3 sum = texture( history, vec2( tc12.x, tc0.y ) ).rgb * ( w12.x * w0.y )
        + texture( history, vec2( tc0.x, tc12.y ) ).rgb * ( w0.x * w12.y )
        + texture( history, vec2( tc12.x, tc12.y ) ).rgb * ( w12.x * w12.y )
        + texture( history, vec2( tc3.x, tc12.y ) ).rgb * ( w3.x * w12.y )
        + texture( history, vec2( tc12.x, tc3.y ) ).rgb * ( w12.x * w3.y );
    float weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return clamp( sum / max( weight, 1e-4 ), 0.0, 1.0 );
}

/** Pulls a colour toward the centre of a box until it lies inside. */
vec3 clipToBox( vec3 centre, vec3 extent, vec3 colour ) {
    vec3 offset = colour - centre;
    vec3 reach = abs( offset ) / max( extent, vec3( 1e-5 ) );
    float furthest = max( reach.x, max( reach.y, reach.z ) );
    return furthest > 1.0 ? centre + offset / furthest : colour;
}

float distanceOf( float depth ) {
    return depthToDistance.y / ( depth * 2.0 - 1.0 + depthToDistance.x );
}

void main() {
    vec2 inputPosition = vUv * inputSize;
    ivec2 base = ivec2( floor( inputPosition ) );
    ivec2 last = ivec2( inputSize ) - 1;

    // This frame's colour at this output pixel, each drawn pixel weighted by how near its sample fell, in
    // output pixels: a smaller picture lands few samples close to any one output pixel, and the ones that do
    // are what rebuilds its detail. Also the colours around it as a box to hold history to, and the nearest
    // surface to take motion from.
    vec2 toOutput = outputSize / inputSize;
    vec3 gathered = vec3( 0.0 );
    float gatheredWeight = 0.0;
    float nearestSample = 0.0;
    vec3 moment1 = vec3( 0.0 );
    vec3 moment2 = vec3( 0.0 );
    float closest = 1.0;
    ivec2 closestTexel = base;
    float farthestDepth = 0.0;
    float fastestObject = 0.0;
    float depths[ 9 ];
    for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
            ivec2 at = clamp( base + ivec2( x, y ), ivec2( 0 ), last );
            vec3 raw = texelFetch( current, at, 0 ).rgb;
            // A shader's NaN or a stray negative must not enter history, where it would spread and stay.
            raw = all( greaterThanEqual( raw, vec3( 0.0 ) ) ) ? min( raw, vec3( 1e4 ) ) : vec3( 0.0 );
            vec3 colour = compressColour( raw );
            vec2 away = ( vec2( at ) + 0.5 - jitter - inputPosition ) * toOutput;
            float weight = exp( -2.29 * dot( away, away ) );
            gathered += colour * weight;
            gatheredWeight += weight;
            nearestSample = max( nearestSample, weight );
            vec3 box = toYCoCg( colour );
            moment1 += box;
            moment2 += box * box;
            float depth = texelFetch( depthMap, at, 0 ).r;
            depths[ ( x + 1 ) + ( y + 1 ) * 3 ] = depth;
            if ( depth < closest ) {
                closest = depth;
                closestTexel = at;
            }
            farthestDepth = max( farthestDepth, depth );
            vec2 moved = texelFetch( objectVelocity, at, 0 ).rg * outputSize;
            fastestObject = max( fastestObject, dot( moved, moved ) );
        }
    }
    gathered /= max( gatheredWeight, 1e-4 );

    vec3 mean = moment1 / 9.0;
    vec3 deviation = sqrt( max( moment2 / 9.0 - mean * mean, vec3( 0.0 ) ) );
    float farDistance = distanceOf( farthestDepth );
    // Raw depth runs in a straight line across any flat surface on screen, however steeply it is seen, so what
    // bends a line through this pixel is an edge. As a share of the distance, so it means the same near and far.
    float bend = max(
        max( abs( depths[ 3 ] + depths[ 5 ] - 2.0 * depths[ 4 ] ), abs( depths[ 1 ] + depths[ 7 ] - 2.0 * depths[ 4 ] ) ),
        max( abs( depths[ 0 ] + depths[ 8 ] - 2.0 * depths[ 4 ] ), abs( depths[ 2 ] + depths[ 6 ] - 2.0 * depths[ 4 ] ) )
    ) * 2.0;
    bool depthEdge = depthToDistance.z > 0.5 ? bend * distanceOf( closest ) / abs( depthToDistance.y ) > 0.003 : bend > 0.001;
    bool objectNear = fastestObject > 0.0625; // a quarter of a pixel a frame

    vec2 closestUv = ( vec2( closestTexel ) + 0.5 ) / inputSize;
    vec4 cameraBefore = reprojection * vec4( closestUv * 2.0 - 1.0, closest * 2.0 - 1.0, 1.0 );
    vec2 velocity = texelFetch( objectVelocity, closestTexel, 0 ).rg;
    bool objectMoved = velocity != vec2( 0.0 );
    if ( !objectMoved ) velocity = closestUv - ( cameraBefore.xy / cameraBefore.w * 0.5 + 0.5 );

    // Velocity comes from the nearest surface here, so this says whether what makes the edge is holding still.
    // A tree sliding across a still sky under a moving camera would otherwise leave its contrast on the sky.
    float speed = length( velocity * outputSize );
    float seenContrast = depthEdge && !objectNear ? deviation.x * ( 1.0 - smoothstep( 0.1, 0.75, speed ) ) : 0.0;

    vec2 historyUv = vUv - velocity;
    // Behind last frame's camera a surface has no place on its screen, and dividing would mirror it onto one.
    bool usable = hasHistory > 0.5 && ( objectMoved || cameraBefore.w > 0.0 )
        && all( greaterThanEqual( historyUv, vec2( 0.0 ) ) ) && all( lessThanEqual( historyUv, vec2( 1.0 ) ) );
    if ( usable && !objectMoved && depthToDistance.z > 0.5 ) {
        // Every surface around here last frame stood well in front of where this one stood: it was hidden.
        ivec2 corner = ivec2( floor( historyUv * outputSize - 0.5 ) );
        ivec2 lastOutput = ivec2( outputSize ) - 1;
        float farthest = max(
            max( texelFetch( companionHistory, clamp( corner, ivec2( 0 ), lastOutput ), 0 ).g, texelFetch( companionHistory, clamp( corner + ivec2( 1, 0 ), ivec2( 0 ), lastOutput ), 0 ).g ),
            max( texelFetch( companionHistory, clamp( corner + ivec2( 0, 1 ), ivec2( 0 ), lastOutput ), 0 ).g, texelFetch( companionHistory, clamp( corner + ivec2( 1, 1 ), ivec2( 0 ), lastOutput ), 0 ).g )
        );
        // The matrix runs from clip space to clip space, so its w is last frame's distance over this frame's.
        if ( farthest < cameraBefore.w * distanceOf( closest ) * 0.97 - 0.02 ) usable = false;
    }
    if ( !usable ) {
        resolved = vec4( gathered, nearestSample );
        companion = vec4( seenContrast, farDistance, 0.0, 1.0 );
        return;
    }

    float motion = smoothstep( 0.25, 4.0, speed );
    // Memory rides with the surface behind: under a moving view a silhouette slides across that surface, and
    // what it left there would hold the box open behind it as a wake. It is only good while things hold still.
    float remembered = max( seenContrast, texture( companionHistory, historyUv ).r * contrastFade * ( 1.0 - motion ) );
    // A line hit by one sample of the nine shows a deviation of about a third of its contrast, so reaching three
    // times the remembered figure spans the whole way from the line's colour to what lies behind it.
    vec3 extent = max( deviation * mix( clipSpread.x, clipSpread.y, motion ), vec3( remembered * mix( 3.0, 1.0, motion ) ) );
    vec3 kept = clipToBox( mean, extent, toYCoCg( sampleHistory( historyUv ) ) );

    // A running mean weighted by how near each frame's sample fell: a pixel just uncovered takes what it can
    // get, then good samples outweigh the rest. The floor keeps old samples from outstaying their welcome.
    float settled = texture( history, historyUv ).a;
    float share = max( nearestSample / max( settled + nearestSample, 1e-4 ), mix( blendFloor.x, blendFloor.y, motion ) * nearestSample );
    // What moves is resampled every frame and softens; it leans on the new frame a little more.
    share = max( share, 0.16 * smoothstep( 1.0, 24.0, speed ) );

    vec3 colour = mix( fromYCoCg( kept ), gathered, share );
    resolved = vec4( clamp( colour, 0.0, 1.0 ), min( settled + nearestSample, 64.0 ) );
    companion = vec4( remembered, farDistance, 0.0, 1.0 );
}`;

export const OUTPUT_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;
layout( location = 0 ) out vec4 presented;
in vec2 vUv;
uniform sampler2D resolved;
uniform sampler2D depthMap;
/** Where this frame's depth lies from where it would without the jitter, in uv. */
uniform vec2 jitterUv;
uniform float sharpness;
${COMPRESSION}

float brightest( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }

void main() {
    ivec2 at = ivec2( gl_FragCoord.xy );
    ivec2 last = textureSize( resolved, 0 ) - 1;
    vec3 centre = texelFetch( resolved, at, 0 ).rgb;
    vec3 colour = centre;
    if ( sharpness > 0.0 ) {
        // Contrast-adaptive: sharpens by what the neighbourhood leaves room for, so edges do not overshoot.
        vec3 north = texelFetch( resolved, clamp( at + ivec2( 0, 1 ), ivec2( 0 ), last ), 0 ).rgb;
        vec3 south = texelFetch( resolved, clamp( at - ivec2( 0, 1 ), ivec2( 0 ), last ), 0 ).rgb;
        vec3 east = texelFetch( resolved, clamp( at + ivec2( 1, 0 ), ivec2( 0 ), last ), 0 ).rgb;
        vec3 west = texelFetch( resolved, clamp( at - ivec2( 1, 0 ), ivec2( 0 ), last ), 0 ).rgb;
        float lowest = min( brightest( centre ), min( brightest( north ), min( brightest( south ), min( brightest( east ), brightest( west ) ) ) ) );
        float highest = max( brightest( centre ), max( brightest( north ), max( brightest( south ), max( brightest( east ), brightest( west ) ) ) ) );
        float room = sqrt( clamp( min( lowest, 1.0 - highest ) / max( highest, 1e-4 ), 0.0, 1.0 ) );
        float lobe = -room * sharpness * 0.2;
        colour = clamp( ( centre + lobe * ( north + south + east + west ) ) / ( 1.0 + 4.0 * lobe ), 0.0, 1.0 );
    }
    presented = vec4( expandColour( colour ), 1.0 );
    gl_FragDepth = texture( depthMap, vUv + jitterUv ).r;
}`;

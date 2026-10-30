import { TRANSMITTANCE_LOOKUP } from './atmosphereShaders';

/**
 * VOLUMETRIC CLOUDS
 *
 * Clouds are a thick shell of air far overhead, ray marched from the camera's position into their own map
 * of the upper sky (a stereographic projection, so the crowded horizon gets the most texels). A sixteenth
 * of the map's texels are traced each frame, so the cost does not depend on the screen, turning the camera
 * costs nothing, and the Sky Light and reflections see the same clouds.
 *
 * Their shapes come from tiling 3D noise (billowy Perlin-Worley for the body, finer Worley eating at the
 * edges) under a 2D weather map that says where clouds are. Light follows the usual model for thick cloud:
 * attenuated toward the sun, with its strongest scattering forward (the silver lining) and a few fainter,
 * softer orders standing in for the many times light bounces inside.
 */

const TILING_NOISE = /* glsl */ `
vec3 hash3( vec3 p ) {
    p = vec3( dot( p, vec3( 127.1, 311.7, 74.7 ) ), dot( p, vec3( 269.5, 183.3, 246.1 ) ), dot( p, vec3( 113.5, 271.9, 124.6 ) ) );
    return fract( sin( p ) * 43758.5453123 );
}
// Bright at the centre of each cell and dark between: billows. Tiles every 'period' cells.
float worley( vec3 p, float period ) {
    vec3 cell = floor( p );
    vec3 f = p - cell;
    float nearest = 1.0;
    for ( int x = - 1; x <= 1; x ++ ) {
        for ( int y = - 1; y <= 1; y ++ ) {
            for ( int z = - 1; z <= 1; z ++ ) {
                vec3 o = vec3( float( x ), float( y ), float( z ) );
                vec3 d = o + hash3( mod( cell + o, period ) ) - f;
                nearest = min( nearest, dot( d, d ) );
            }
        }
    }
    return 1.0 - sqrt( nearest );
}
float gradientNoise( vec3 p, float period ) {
    vec3 i = floor( p );
    vec3 f = p - i;
    vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    float n000 = dot( hash3( mod( i, period ) ) * 2.0 - 1.0, f );
    float n100 = dot( hash3( mod( i + vec3( 1.0, 0.0, 0.0 ), period ) ) * 2.0 - 1.0, f - vec3( 1.0, 0.0, 0.0 ) );
    float n010 = dot( hash3( mod( i + vec3( 0.0, 1.0, 0.0 ), period ) ) * 2.0 - 1.0, f - vec3( 0.0, 1.0, 0.0 ) );
    float n110 = dot( hash3( mod( i + vec3( 1.0, 1.0, 0.0 ), period ) ) * 2.0 - 1.0, f - vec3( 1.0, 1.0, 0.0 ) );
    float n001 = dot( hash3( mod( i + vec3( 0.0, 0.0, 1.0 ), period ) ) * 2.0 - 1.0, f - vec3( 0.0, 0.0, 1.0 ) );
    float n101 = dot( hash3( mod( i + vec3( 1.0, 0.0, 1.0 ), period ) ) * 2.0 - 1.0, f - vec3( 1.0, 0.0, 1.0 ) );
    float n011 = dot( hash3( mod( i + vec3( 0.0, 1.0, 1.0 ), period ) ) * 2.0 - 1.0, f - vec3( 0.0, 1.0, 1.0 ) );
    float n111 = dot( hash3( mod( i + vec3( 1.0, 1.0, 1.0 ), period ) ) * 2.0 - 1.0, f - vec3( 1.0, 1.0, 1.0 ) );
    return mix( mix( mix( n000, n100, u.x ), mix( n010, n110, u.x ), u.y ), mix( mix( n001, n101, u.x ), mix( n011, n111, u.x ), u.y ), u.z );
}
float perlinFbm( vec3 p, float period, int octaves ) {
    float sum = 0.0;
    float amplitude = 1.0;
    float frequency = 1.0;
    float total = 0.0;
    for ( int i = 0; i < octaves; i ++ ) {
        sum += gradientNoise( p * frequency, period * frequency ) * amplitude;
        total += amplitude;
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    return sum / total * 0.5 + 0.5;
}
float worleyFbm( vec3 p, float period ) {
    return worley( p, period ) * 0.625 + worley( p * 2.0, period * 2.0 ) * 0.25 + worley( p * 4.0, period * 4.0 ) * 0.125;
}
float remap( float value, float fromLow, float fromHigh, float toLow, float toHigh ) {
    return toLow + ( value - fromLow ) * ( toHigh - toLow ) / ( fromHigh - fromLow );
}`;

/** One slice of the tiling cloud body: R billowy Perlin-Worley, G, B and A Worley at rising frequencies. */
export const CLOUD_SHAPE_FRAGMENT = /* glsl */ `
${TILING_NOISE}
uniform float uSlice;
varying vec2 vUv;
void main() {
    vec3 p = vec3( vUv, uSlice );
    float perlin = perlinFbm( p * 4.0, 4.0, 5 );
    float billows = worleyFbm( p * 4.0, 4.0 );
    float body = clamp( remap( perlin, billows - 1.0, 1.0, 0.0, 1.0 ), 0.0, 1.0 );
    gl_FragColor = vec4( body, worleyFbm( p * 4.0, 4.0 ), worleyFbm( p * 8.0, 8.0 ), worleyFbm( p * 16.0, 16.0 ) );
}`;

/** One slice of the fine detail that eats at the clouds' edges. */
export const CLOUD_DETAIL_FRAGMENT = /* glsl */ `
${TILING_NOISE}
uniform float uSlice;
varying vec2 vUv;
void main() {
    vec3 p = vec3( vUv, uSlice );
    gl_FragColor = vec4( worleyFbm( p * 4.0, 4.0 ), worleyFbm( p * 8.0, 8.0 ), worleyFbm( p * 16.0, 16.0 ), 1.0 );
}`;

/** Where clouds are: R how much cloud a place tends to have, G what kind (low and flat, or tall). Tiles. */
export const CLOUD_WEATHER_FRAGMENT = /* glsl */ `
${TILING_NOISE}
varying vec2 vUv;
void main() {
    vec3 p = vec3( vUv, 0.37 );
    float broad = perlinFbm( p * 5.0, 5.0, 5 );
    float billows = worleyFbm( p * 8.0, 8.0 );
    float amount = clamp( remap( broad, 0.3, 0.72, 0.0, 1.0 ), 0.0, 1.0 ) * 0.62 + billows * 0.38;
    float kind = perlinFbm( p * 3.0 + 7.0, 3.0, 3 );
    gl_FragColor = vec4( amount, clamp( remap( kind, 0.35, 0.65, 0.0, 1.0 ), 0.0, 1.0 ), 0.0, 1.0 );
}`;

/** Traces a sixteenth of the clouds' map. Output: light (per unit of sunlight) and how much of the sky behind shows. */
export const CLOUD_TRACE_FRAGMENT = /* glsl */ `
#define SKY_PI 3.14159265358979
uniform highp sampler3D uShape;
uniform highp sampler3D uDetail;
uniform sampler2D uWeather;
uniform sampler2D uTransmittance;
uniform sampler2D uSkyView;
uniform vec2 uPlanet;
uniform float uViewRadius;
uniform vec3 uKeyDirection;
uniform float uKeyStrength;
uniform vec3 uAmbient;
uniform vec3 uGroundAmbient;
uniform float uCoverage;
uniform float uThreshold;
uniform float uEdge;
uniform float uWeatherTiling;
uniform float uBase;
uniform float uDepth;
uniform float uDensity;
uniform float uDetailAmount;
uniform float uShapeScale;
uniform vec3 uOffset;
uniform float uSkyToCloud;
uniform float uSkyGrey;
uniform ivec2 uTile;
uniform float uPhase;
uniform int uSteps;
varying vec2 vUv;

${TRANSMITTANCE_LOOKUP}

float raySphere( vec3 origin, vec3 direction, float radius ) {
    float b = dot( origin, direction );
    float c = dot( origin, origin ) - radius * radius;
    float d = b * b - c;
    if ( d < 0.0 ) return - 1.0;
    float root = sqrt( d );
    float near = - b - root;
    if ( near > 0.0 ) return near;
    float far = - b + root;
    return far > 0.0 ? far : - 1.0;
}

float linearStep( float low, float high, float value ) { return clamp( ( value - low ) / ( high - low ), 0.0, 1.0 ); }
float reMap( float value, float fromLow, float fromHigh, float toLow, float toHigh ) {
    return toLow + ( value - fromLow ) * ( toHigh - toLow ) / ( fromHigh - fromLow );
}

float cloudDensity( vec3 point, float height, bool fine, float lod ) {
    vec2 weatherAt = ( point.xz + uOffset.xz ) * uWeatherTiling / uShapeScale;
    vec2 weather = textureLod( uWeather, weatherAt, 0.0 ).rg;
    float cover = linearStep( uThreshold, uThreshold + uEdge, weather.r );
    if ( cover <= 0.001 ) return 0.0;
    // Rounded below; flat-topped or tall by what kind of cloud grows here, thin at the top.
    float peak = mix( 0.38, 1.0, weather.g * weather.g );
    float profile = smoothstep( 0.0, 0.07, height ) * ( 1.0 - smoothstep( peak * 0.55, peak, height ) );
    if ( profile <= 0.0 ) return 0.0;
    vec3 at = vec3( point.x + uOffset.x, point.y * 1.8, point.z + uOffset.z ) * 0.17 / uShapeScale;
    vec4 shape = textureLod( uShape, at, lod );
    // Both noises sit in narrow bands (measured): spread them to the full range, so they carve real shapes.
    float body0 = linearStep( 0.6, 0.74, shape.r );
    float billows = linearStep( 0.36, 0.62, shape.g * 0.42 + shape.b * 0.34 + shape.a * 0.24 );
    float base = body0 * 0.45 + billows * 0.55;
    // What is left once coverage and height have eaten the shape away.
    float body = clamp( reMap( base * profile, 1.0 - cover, 1.0, 0.0, 1.0 ), 0.0, 1.0 );
    if ( body <= 0.0 ) return 0.0;
    if ( fine && uDetailAmount > 0.0 ) {
        vec3 detail = textureLod( uDetail, ( point + vec3( uOffset.x, 0.0, uOffset.z ) ) * 1.3 / uShapeScale, lod ).rgb;
        float wisps = linearStep( 0.22, 0.78, detail.r * 0.5 + detail.g * 0.3 + detail.b * 0.2 );
        // Wispy at the base, billowed higher up.
        wisps = mix( 1.0 - wisps, wisps, clamp( height * 5.0, 0.0, 1.0 ) );
        body = clamp( reMap( body, wisps * uDetailAmount * 0.85, 1.0, 0.0, 1.0 ), 0.0, 1.0 );
    }
    // Dense soon after its edge, as a cloud is: not a slow fade through its whole body.
    return min( body * 3.2, 1.0 );
}

float henyeyGreenstein( float c, float g ) {
    float g2 = g * g;
    return ( 1.0 - g2 ) / ( 4.0 * SKY_PI * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}

// Forward glow and a little scattered back.
float cloudPhase( float c ) {
    return mix( henyeyGreenstein( c, - 0.2 ), henyeyGreenstein( c, 0.82 ), 0.55 );
}

float sunwardDepth( vec3 point, float innerRadius, float depth, float extinction ) {
    float sum = 0.0;
    float stride = 0.09;
    vec3 p = point;
    for ( int i = 0; i < 6; i ++ ) {
        p += uKeyDirection * stride;
        float height = ( sqrt( dot( p, p ) ) - innerRadius ) / depth;
        if ( height >= 1.0 ) break;
        if ( height > 0.0 ) sum += cloudDensity( p, height, false, 1.0 + float( i ) * 0.5 ) * stride;
        stride *= 1.7;
    }
    return sum * extinction;
}

vec2 viewUv( vec3 direction ) {
    float latitude = asin( clamp( direction.y, - 1.0, 1.0 ) );
    return vec2( atan( direction.z, direction.x ) / ( 2.0 * SKY_PI ) + 0.5, 0.5 + 0.5 * sign( latitude ) * sqrt( abs( latitude ) / ( SKY_PI * 0.5 ) ) );
}

void main() {
    ivec2 texel = ivec2( gl_FragCoord.xy );
    if ( ( texel.x & 3 ) != uTile.x || ( texel.y & 3 ) != uTile.y ) discard;
    vec2 q = vUv * 2.0 - 1.0;
    float rr = dot( q, q );
    if ( rr > 1.08 ) {
        gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
        return;
    }
    vec3 direction = vec3( 2.0 * q.x, max( 1.0 - rr, 0.0 ), 2.0 * q.y ) / ( 1.0 + rr );
    direction = normalize( direction );

    float inner = uPlanet.x + uBase;
    float outer = inner + uDepth;
    vec3 origin = vec3( 0.0, uViewRadius, 0.0 );
    float start = uViewRadius < inner ? raySphere( origin, direction, inner ) : 0.0;
    float stop = raySphere( origin, direction, outer );
    if ( start < 0.0 || stop <= start ) {
        gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
        return;
    }
    // Past this the clouds are lost in the haze anyway.
    stop = min( stop, start + 70.0 );

    float noise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) + uPhase );
    int steps = uSteps;
    float dt = ( stop - start ) / float( steps );
    float extinction = 46.0 * uDensity;
    float cosine = dot( direction, uKeyDirection );
    vec3 light = vec3( 0.0 );
    float through = 1.0;
    float firstHit = - 1.0;
    float empty = 0.0;
    for ( int i = 0; i < steps; i ++ ) {
        float t = start + ( float( i ) + noise ) * dt;
        vec3 point = origin + direction * t;
        float radius = sqrt( dot( point, point ) );
        float height = ( radius - inner ) / uDepth;
        if ( height < 0.0 || height > 1.0 ) continue;
        float lod = clamp( t / 18.0, 0.0, 2.0 );
        float density = cloudDensity( point, height, t < 35.0, lod );
        if ( density <= 0.002 ) continue;
        if ( firstHit < 0.0 ) firstHit = t;
        float sigma = density * extinction;
        float toward = sunwardDepth( point, inner, uDepth, extinction );
        float mu = dot( point, uKeyDirection ) / radius;
        vec3 sunlight = textureLod( uTransmittance, transmittanceUvFor( radius, mu ), 0.0 ).rgb * uKeyStrength;
        // Three orders of scattering, each softer and reaching deeper than the last.
        float a = 1.0;
        float b = 1.0;
        float c = 1.0;
        float scattered = 0.0;
        for ( int order = 0; order < 3; order ++ ) {
            scattered += a * exp( - toward * b ) * cloudPhase( cosine * c );
            a *= 0.5;
            b *= 0.42;
            c *= 0.5;
        }
        // Thick cloud is nearly white for what light falls on it: most of what lights it has bounced many
        // times over and comes from every way. That is what makes a cloud bright on the side away from the sun.
        // Some of it gets all the way through: under a thick deck the light is dim and even, not black.
        scattered += 0.26 * ( 0.66 * exp( - toward * 0.11 ) + 0.34 * exp( - toward * 0.009 ) );
        // Dark at the sunny edge of a thick cloud's folds, where light has not yet built up.
        scattered *= 1.0 - 0.4 * exp( - toward * 1.8 ) * ( 1.0 - 0.75 * max( cosine, 0.0 ) );
        vec3 ambient = mix( uGroundAmbient, uAmbient, clamp( height * 1.2 + 0.15, 0.0, 1.0 ) ) * 2.5;
        // Deep inside, what light there is has lost the blue sky's colour.
        ambient = mix( vec3( dot( ambient, vec3( 0.2126, 0.7152, 0.0722 ) ) ), ambient, exp( - toward * 0.02 ) );
        vec3 source = ( sunlight * scattered + ambient ) * sigma;
        float stepThrough = exp( - sigma * dt );
        light += through * ( source - source * stepThrough ) / max( sigma, 1e-4 );
        through *= stepThrough;
        if ( through < 0.008 ) break;
    }
    if ( firstHit > 0.0 ) {
        // Distant clouds sink into the air between: toward the sky's own colour there.
        vec3 sky = textureLod( uSkyView, viewUv( direction ), 0.0 ).rgb * uSkyToCloud;
        sky = mix( sky, vec3( dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) ) ), uSkyGrey );
        float air = exp( - firstHit / 38.0 );
        light = mix( sky * ( 1.0 - through ), light, air );
    }
    gl_FragColor = vec4( max( light, vec3( 0.0 ) ), through );
}`;

/**
 * The sky visibility map, from the height of what stands highest at each spot, seen from straight above.
 * R: how much sky reaches the top of what is there, G: how much reaches under it, from how open the
 * place around it is; B: its height.
 */
export const SKY_VISIBILITY_FRAGMENT = /* glsl */ `
uniform highp sampler2D uDepth;
uniform float uTop;
uniform float uDepthRange;
uniform float uTexelMetres;
uniform float uSize;
varying vec2 vUv;

// The camera looked down with -z at the top of its picture; this map runs with +z.
float depthAt( vec2 uv ) {
    return textureLod( uDepth, vec2( uv.x, 1.0 - uv.y ), 0.0 ).r;
}
float heightAt( vec2 uv ) {
    return uTop - depthAt( uv ) * uDepthRange;
}

void main() {
    // Nothing there at all: open to the sky.
    if ( depthAt( vUv ) >= 0.9999 ) {
        gl_FragColor = vec4( 1.0, 1.0, - 1000.0, 1.0 );
        return;
    }
    float here = heightAt( vUv );
    float blocked = 0.0;
    float open = 0.0;
    float weightTotal = 0.0;
    const int DIRECTIONS = 12;
    const int STEPS = 9;
    // Turned and started differently per texel, so fixed radii leave no rings; the blur that follows evens this out.
    float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    for ( int d = 0; d < DIRECTIONS; d ++ ) {
        float angle = ( float( d ) + jitter ) / float( DIRECTIONS ) * 6.2831853;
        vec2 way = vec2( cos( angle ), sin( angle ) );
        float horizon = 0.0;
        float metres = max( 0.6, uTexelMetres * 1.2 ) * ( 0.7 + 0.6 * fract( jitter + float( d ) * 0.381966 ) );
        for ( int s = 0; s < STEPS; s ++ ) {
            vec2 uv = vUv + way * metres / uSize;
            float above = heightAt( uv ) - here;
            if ( above > 0.0 ) horizon = max( horizon, above / sqrt( above * above + metres * metres ) );
            float weight = 1.0 / metres;
            open += weight * smoothstep( 0.15, 1.2, - above );
            weightTotal += weight;
            metres *= 1.5;
        }
        // Sky a level surface sees over this side: all of it but what lies under the horizon, cosine weighted.
        blocked += horizon * horizon;
    }
    // What is under something has lost the sky overhead, the part that counts most: never more than this of it.
    // What stands beside a place shades it less than the geometry alone says: light bounces off what blocks the sky.
    gl_FragColor = vec4( pow( 1.0 - blocked / float( DIRECTIONS ), 0.55 ), open / weightTotal * 0.55, here, 1.0 );
}`;

/** Evens out the visibility map's noise, across what stands at about the same height only, so edges stay where they are. */
export const SKY_VISIBILITY_BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D uRaw;
varying vec2 vUv;
void main() {
    vec4 centre = textureLod( uRaw, vUv, 0.0 );
    vec2 sum = centre.rg;
    float weight = 1.0;
    float heightSum = centre.b;
    float heightWeight = 1.0;
    const float TEXEL = 1.0 / 512.0;
    for ( int x = - 2; x <= 2; x ++ ) {
        for ( int y = - 2; y <= 2; y ++ ) {
            if ( x == 0 && y == 0 ) continue;
            vec4 other = textureLod( uRaw, vUv + vec2( float( x ), float( y ) ) * TEXEL, 0.0 );
            float near = 1.0 / ( 1.0 + float( x * x + y * y ) * 0.35 );
            float w = near * exp( - abs( other.b - centre.b ) * 1.2 );
            sum += other.rg * w;
            weight += w;
            // A soft height, so a place goes from open to covered over a stretch and not at a line.
            heightSum += other.b * near;
            heightWeight += near;
        }
    }
    gl_FragColor = vec4( sum / weight, heightSum / heightWeight, 1.0 );
}`;

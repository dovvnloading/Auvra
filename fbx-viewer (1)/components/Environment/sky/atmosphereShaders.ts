import { MIE_HEIGHT, OZONE_CENTRE, OZONE_HALF_WIDTH, RAYLEIGH_HEIGHT } from '../../../runtime/sky/atmosphere';

/**
 * THE ATMOSPHERE, ON THE GPU
 *
 * The air's light is precomputed into small tables, each resting on the last, so drawing the sky costs
 * one lookup however thick the air: how much light gets through the air from any height at any angle
 * (transmittance), the light scattered many times over (multiple scattering, solved for all orders at
 * once), and the sky as seen from the camera's height in every direction (sky view). The first two change
 * only with the atmosphere's settings; the last whenever the sun or moon moves.
 *
 * Distances are kilometres, and light is per unit of sunlight above the air, as in runtime/sky/atmosphere.ts.
 */

export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

const COMMON = /* glsl */ `
#define SKY_PI 3.14159265358979
uniform vec2 uPlanet; // ground and top of the air: radii
uniform vec3 uRayleigh;
uniform vec3 uMieScatter;
uniform vec3 uMieAbsorb;
uniform vec3 uOzone;
uniform vec3 uGroundAlbedo;
uniform float uMieG;

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

void airAt( float height, out vec3 rayleigh, out vec3 mie, out vec3 extinction ) {
    float airDensity = exp( - height / ${RAYLEIGH_HEIGHT.toFixed(1)} );
    float hazeDensity = exp( - height / ${MIE_HEIGHT.toFixed(1)} );
    float ozoneDensity = max( 0.0, 1.0 - abs( height - ${OZONE_CENTRE.toFixed(1)} ) / ${OZONE_HALF_WIDTH.toFixed(1)} );
    rayleigh = uRayleigh * airDensity;
    mie = uMieScatter * hazeDensity;
    extinction = rayleigh + mie + uMieAbsorb * hazeDensity + uOzone * ozoneDensity;
}

float rayleighPhase( float c ) { return 3.0 / ( 16.0 * SKY_PI ) * ( 1.0 + c * c ); }

float miePhase( float c, float g ) {
    float k = 1.0 + g * g - 2.0 * g * c;
    return 3.0 / ( 8.0 * SKY_PI ) * ( 1.0 - g * g ) * ( 1.0 + c * c ) / ( ( 2.0 + g * g ) * pow( max( k, 1e-4 ), 1.5 ) );
}

// The transmittance table's coordinates: spread so the horizon, where it changes fastest, gets the most texels.
vec2 transmittanceUv( float r, float mu ) {
    float top = uPlanet.y;
    float ground = uPlanet.x;
    float H = sqrt( top * top - ground * ground );
    float rho = sqrt( max( 0.0, r * r - ground * ground ) );
    float discriminant = r * r * ( mu * mu - 1.0 ) + top * top;
    float d = max( 0.0, - r * mu + sqrt( max( 0.0, discriminant ) ) );
    float dMin = top - r;
    float dMax = rho + H;
    return vec2( ( d - dMin ) / max( dMax - dMin, 1e-5 ), rho / H );
}

// Light reaching a point from a body at cosine mu from straight up: fades as the body sinks past the point's horizon.
float aboveHorizon( float r, float mu ) {
    float s = uPlanet.x / r;
    float horizon = - sqrt( max( 0.0, 1.0 - s * s ) );
    return smoothstep( horizon - 0.008, horizon + 0.008, mu );
}`;

export const TRANSMITTANCE_FRAGMENT = /* glsl */ `
${COMMON}
varying vec2 vUv;
void main() {
    float top = uPlanet.y;
    float ground = uPlanet.x;
    float H = sqrt( top * top - ground * ground );
    float rho = H * vUv.y;
    float r = sqrt( rho * rho + ground * ground );
    float dMin = top - r;
    float dMax = rho + H;
    float d = dMin + vUv.x * ( dMax - dMin );
    float mu = d <= 0.0 ? 1.0 : clamp( ( H * H - rho * rho - d * d ) / ( 2.0 * r * d ), - 1.0, 1.0 );
    vec3 origin = vec3( 0.0, r, 0.0 );
    vec3 direction = vec3( sqrt( max( 0.0, 1.0 - mu * mu ) ), mu, 0.0 );
    float toGround = raySphere( origin, direction, ground );
    float rayLength = toGround > 0.0 ? toGround : raySphere( origin, direction, top );
    vec3 depth = vec3( 0.0 );
    float stepSize = rayLength / 40.0;
    for ( int i = 0; i < 40; i ++ ) {
        vec3 point = origin + direction * ( ( float( i ) + 0.5 ) * stepSize );
        vec3 rayleigh, mie, extinction;
        airAt( max( 0.0, sqrt( dot( point, point ) ) - ground ), rayleigh, mie, extinction );
        depth += extinction * stepSize;
    }
    gl_FragColor = vec4( exp( - depth ), 1.0 );
}`;

/**
 * For each height and sun angle: what an isotropic shell of scattered light adds up to over every order
 * of scattering. Light that has scattered twice looks much the same as light that has scattered once more,
 * so the orders form a geometric series with one transfer ratio, summed in closed form.
 */
export const MULTISCATTER_FRAGMENT = /* glsl */ `
${COMMON}
uniform sampler2D uTransmittance;
varying vec2 vUv;
#define SPHERE_SAMPLES 64
#define MARCH_STEPS 20
void main() {
    float cosSun = vUv.x * 2.0 - 1.0;
    float ground = uPlanet.x;
    float top = uPlanet.y;
    float r = ground + 0.001 + vUv.y * ( top - ground - 0.002 );
    vec3 origin = vec3( 0.0, r, 0.0 );
    vec3 sun = vec3( sqrt( max( 0.0, 1.0 - cosSun * cosSun ) ), cosSun, 0.0 );
    vec3 secondOrder = vec3( 0.0 );
    vec3 transfer = vec3( 0.0 );
    for ( int s = 0; s < SPHERE_SAMPLES; s ++ ) {
        // Evenly over the sphere (a Fibonacci spiral).
        float index = float( s ) + 0.5;
        float z = 1.0 - 2.0 * index / float( SPHERE_SAMPLES );
        float phi = SKY_PI * ( 3.0 - sqrt( 5.0 ) ) * index;
        float across = sqrt( max( 0.0, 1.0 - z * z ) );
        vec3 direction = vec3( across * cos( phi ), z, across * sin( phi ) );
        float toGround = raySphere( origin, direction, ground );
        float toTop = raySphere( origin, direction, top );
        float rayLength = toGround > 0.0 ? toGround : toTop;
        if ( rayLength <= 0.0 ) continue;
        float stepSize = rayLength / float( MARCH_STEPS );
        vec3 throughput = vec3( 1.0 );
        for ( int i = 0; i < MARCH_STEPS; i ++ ) {
            vec3 point = origin + direction * ( ( float( i ) + 0.5 ) * stepSize );
            float radius = sqrt( dot( point, point ) );
            vec3 rayleigh, mie, extinction;
            airAt( max( 0.0, radius - ground ), rayleigh, mie, extinction );
            vec3 scattering = rayleigh + mie;
            vec3 stepThrough = exp( - extinction * stepSize );
            float mu = dot( point, sun ) / radius;
            vec3 sunlight = textureLod( uTransmittance, transmittanceUv( radius, mu ), 0.0 ).rgb * aboveHorizon( radius, mu );
            vec3 source = scattering * sunlight / ( 4.0 * SKY_PI );
            vec3 safeExtinction = max( extinction, vec3( 1e-6 ) );
            secondOrder += throughput * ( source - source * stepThrough ) / safeExtinction;
            transfer += throughput * ( scattering - scattering * stepThrough ) / safeExtinction;
            throughput *= stepThrough;
        }
        if ( toGround > 0.0 ) {
            vec3 point = origin + direction * toGround;
            vec3 up = normalize( point );
            float mu = dot( up, sun );
            vec3 sunlight = textureLod( uTransmittance, transmittanceUv( ground + 0.001, mu ), 0.0 ).rgb;
            secondOrder += throughput * sunlight * max( mu, 0.0 ) * uGroundAlbedo / SKY_PI;
        }
    }
    // Each sample stands for 4 pi / N of the sphere and scattering back into a point is isotropic (1 / 4 pi): they cancel.
    secondOrder /= float( SPHERE_SAMPLES );
    transfer /= float( SPHERE_SAMPLES );
    vec3 allOrders = secondOrder / max( vec3( 1.0 ) - transfer, vec3( 1e-4 ) );
    gl_FragColor = vec4( allOrders, 1.0 );
}`;

/** The sky seen from the camera's height: every direction, with texels crowding toward the horizon. */
export const SKY_VIEW_FRAGMENT = /* glsl */ `
${COMMON}
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform float uViewRadius;
uniform vec3 uSun;
uniform vec3 uMoon;
uniform float uMoonLight;
uniform vec3 uGlow;
varying vec2 vUv;
#define VIEW_STEPS 32

vec3 multiScatterAt( float radius, float mu ) {
    vec2 uv = vec2( mu * 0.5 + 0.5, ( radius - uPlanet.x ) / ( uPlanet.y - uPlanet.x ) );
    return textureLod( uMultiScatter, clamp( uv, 0.0, 1.0 ), 0.0 ).rgb;
}

void main() {
    float offset = vUv.y - 0.5;
    float latitude = sign( offset ) * ( 2.0 * abs( offset ) ) * ( 2.0 * abs( offset ) ) * SKY_PI * 0.5;
    float longitude = ( vUv.x - 0.5 ) * 2.0 * SKY_PI;
    vec3 direction = vec3( cos( latitude ) * cos( longitude ), sin( latitude ), cos( latitude ) * sin( longitude ) );
    vec3 origin = vec3( 0.0, uViewRadius, 0.0 );
    float toGround = raySphere( origin, direction, uPlanet.x );
    float toTop = raySphere( origin, direction, uPlanet.y );
    float rayLength = toGround > 0.0 ? toGround : toTop;
    vec3 light = vec3( 0.0 );
    vec3 throughput = vec3( 1.0 );
    if ( rayLength > 0.0 ) {
        float cosSun = dot( direction, uSun );
        float cosMoon = dot( direction, uMoon );
        float airSun = rayleighPhase( cosSun );
        float hazeSun = miePhase( cosSun, uMieG );
        float airMoon = rayleighPhase( cosMoon );
        float hazeMoon = miePhase( cosMoon, uMieG );
        float previous = 0.0;
        for ( int i = 0; i < VIEW_STEPS; i ++ ) {
            float f = ( float( i ) + 1.0 ) / float( VIEW_STEPS );
            float t = rayLength * f * f;
            float dt = t - previous;
            vec3 point = origin + direction * ( previous + dt * 0.5 );
            previous = t;
            float radius = sqrt( dot( point, point ) );
            vec3 rayleigh, mie, extinction;
            airAt( max( 0.0, radius - uPlanet.x ), rayleigh, mie, extinction );
            float muSun = dot( point, uSun ) / radius;
            vec3 sunlight = textureLod( uTransmittance, transmittanceUv( radius, muSun ), 0.0 ).rgb * aboveHorizon( radius, muSun );
            vec3 scattered = rayleigh + mie;
            vec3 source = ( rayleigh * airSun + mie * hazeSun ) * sunlight + scattered * multiScatterAt( radius, muSun );
            if ( uMoonLight > 0.0 ) {
                float muMoon = dot( point, uMoon ) / radius;
                vec3 moonlight = textureLod( uTransmittance, transmittanceUv( radius, muMoon ), 0.0 ).rgb * aboveHorizon( radius, muMoon );
                source += uMoonLight * ( ( rayleigh * airMoon + mie * hazeMoon ) * moonlight + scattered * multiScatterAt( radius, muMoon ) );
            }
            vec3 stepThrough = exp( - extinction * dt );
            light += throughput * ( source - source * stepThrough ) / max( extinction, vec3( 1e-6 ) );
            throughput *= stepThrough;
        }
        if ( toGround > 0.0 ) {
            vec3 up = normalize( origin + direction * toGround );
            float mu = dot( up, uSun );
            vec3 sunlight = textureLod( uTransmittance, transmittanceUv( uPlanet.x + 0.001, mu ), 0.0 ).rgb;
            // Sunlit, and lit by the sky above it.
            vec3 fill = multiScatterAt( uPlanet.x + 0.001, mu );
            light += throughput * uGroundAlbedo * ( sunlight * max( mu, 0.0 ) / SKY_PI + fill * 0.5 );
        }
    }
    // The night air's own faint glow, strongest low down where the eye looks through the most of it.
    float altitude = max( direction.y, 0.0 );
    light += uGlow * ( 0.45 + 0.55 * ( 1.0 - altitude ) * ( 1.0 - altitude ) ) * ( direction.y < 0.0 ? 0.35 : 1.0 );
    gl_FragColor = vec4( light, 1.0 );
}`;

/** transmittanceUv for what has no atmosphere coefficients to hand: just the planet's size. */
export const TRANSMITTANCE_LOOKUP = /* glsl */ `
vec2 transmittanceUvFor( float r, float mu ) {
    float top = uPlanet.y;
    float ground = uPlanet.x;
    float H = sqrt( top * top - ground * ground );
    float rho = sqrt( max( 0.0, r * r - ground * ground ) );
    float discriminant = r * r * ( mu * mu - 1.0 ) + top * top;
    float d = max( 0.0, - r * mu + sqrt( max( 0.0, discriminant ) ) );
    float dMin = top - r;
    float dMax = rho + H;
    return vec2( ( d - dMin ) / max( dMax - dMin, 1e-5 ), rho / H );
}`;

/** Where a direction falls in the sky-view table. */
const SKY_VIEW_LOOKUP = /* glsl */ `
vec2 skyViewUv( vec3 direction ) {
    float latitude = asin( clamp( direction.y, - 1.0, 1.0 ) );
    float v = 0.5 + 0.5 * sign( latitude ) * sqrt( abs( latitude ) / ( 3.14159265358979 * 0.5 ) );
    float u = atan( direction.z, direction.x ) / ( 2.0 * 3.14159265358979 ) + 0.5;
    return vec2( u, v );
}`;

export const SKY_DOME_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
    vDirection = position;
    // Round the camera, at infinity: only the camera's turn matters, so the sky is never clipped or reached.
    gl_Position = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
    gl_Position.z = gl_Position.w;
}`;

const NOISE = /* glsl */ `
float skyHash( vec3 p ) {
    p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float skyNoise( vec3 p ) {
    vec3 i = floor( p );
    vec3 f = fract( p );
    vec3 u = f * f * ( 3.0 - 2.0 * f );
    return mix(
        mix( mix( skyHash( i ), skyHash( i + vec3( 1.0, 0.0, 0.0 ) ), u.x ), mix( skyHash( i + vec3( 0.0, 1.0, 0.0 ) ), skyHash( i + vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y ),
        mix( mix( skyHash( i + vec3( 0.0, 0.0, 1.0 ) ), skyHash( i + vec3( 1.0, 0.0, 1.0 ) ), u.x ), mix( skyHash( i + vec3( 0.0, 1.0, 1.0 ) ), skyHash( i + vec3( 1.0, 1.0, 1.0 ) ), u.x ), u.y ),
        u.z );
}
float skyFbm( vec3 p, int octaves ) {
    float sum = 0.0;
    float amplitude = 0.5;
    float total = 0.0;
    for ( int i = 0; i < octaves; i ++ ) {
        sum += skyNoise( p ) * amplitude;
        total += amplitude;
        p = p * 2.03 + vec3( 3.1, 1.7, 2.3 );
        amplitude *= 0.5;
    }
    return sum / total;
}`;

/**
 * The dome. With SKY_CAPTURE it is what the Sky Light sees: the same air and clouds, without the sun's
 * disc (the sun's own light already lights the scene directly) or the stars' detail.
 */
export const SKY_DOME_FRAGMENT = /* glsl */ `
varying vec3 vDirection;
uniform sampler2D uSkyView;
uniform sampler2D uTransmittance;
uniform sampler2D uClouds;
uniform sampler2D uPanorama;
uniform vec2 uPlanet;
uniform float uViewRadius;
uniform vec3 uSkyScale;
uniform float uSkyGrey;
uniform float uCloudsOn;
uniform vec3 uCloudScale;
uniform vec2 uCloudTexel;
uniform float uFlash;
uniform float uPanoramaOn;
uniform float uPanoramaTurn;
uniform vec3 uPanoramaScale;
uniform vec3 uFlatCloud;
uniform float uFlatCover;
uniform vec3 uLowerColor;
uniform float uLowerSolid;
#ifndef SKY_CAPTURE
uniform vec3 uSun;
uniform vec3 uSunRadiance;
uniform vec2 uSunEdge; // cosines: inner and outer edge of the disc
uniform vec3 uMoon;
uniform vec3 uMoonRight;
uniform vec3 uMoonUp;
uniform float uMoonSine;
uniform vec3 uMoonRadiance;
uniform float uMoonPhase;
uniform float uStars;
uniform float uMilkyWay;
uniform mat3 uStarTurn;
uniform float uTime;
${NOISE}

vec3 starLayer( vec3 direction, float cells, float threshold, float size, float brightness ) {
    vec3 p = direction * cells;
    vec3 id = floor( p );
    float pick = skyHash( id + 19.3 );
    if ( pick > threshold ) return vec3( 0.0 );
    vec3 offset = vec3( skyHash( id + 1.7 ), skyHash( id + 5.3 ), skyHash( id + 9.1 ) ) - 0.5;
    vec3 centre = normalize( id + 0.5 + offset * 0.7 );
    float away = length( direction - centre ) * cells;
    float rank = pick / threshold;
    float disc = exp( - away * away / ( size * size ) );
    // A star's colour by its temperature: most white, some red and some blue.
    float warmth = skyHash( id + 13.9 );
    vec3 colour = mix( vec3( 1.0, 0.72, 0.5 ), mix( vec3( 1.0, 0.97, 0.92 ), vec3( 0.68, 0.8, 1.0 ), smoothstep( 0.45, 1.0, warmth ) ), smoothstep( 0.0, 0.3, warmth ) );
    // Most are faint and a few are bright.
    float strength = brightness * ( 0.12 + 1.6 * pow( 1.0 - rank, 6.0 ) );
    // Twinkling, stronger low down where the light crosses more air.
    float twinkle = 1.0 - 0.45 * ( 1.0 - clamp( direction.y * 2.0, 0.0, 1.0 ) ) * ( 0.5 + 0.5 * sin( uTime * ( 1.5 + 5.0 * warmth ) + 40.0 * pick ) );
    return colour * disc * strength * twinkle;
}

vec3 milkyWay( vec3 direction ) {
    // A band round a tilted great circle, brightest toward its core, split by lanes of dust.
    const vec3 pole = vec3( 0.46, 0.75, - 0.47 );
    const vec3 core = vec3( 0.82, - 0.17, 0.54 );
    float across = dot( direction, pole );
    float towardCore = dot( direction, core ) * 0.5 + 0.5;
    float width = mix( 0.09, 0.2, towardCore * towardCore );
    float band = exp( - across * across / ( width * width ) );
    if ( band < 0.003 ) return vec3( 0.0 );
    float clouds = skyFbm( direction * 7.0, 5 );
    float lanes = smoothstep( 0.35, 0.72, skyFbm( direction * 14.0 + 4.0, 4 ) );
    float dust = 1.0 - 0.75 * lanes * exp( - across * across / ( width * width * 0.28 ) );
    vec3 colour = mix( vec3( 0.55, 0.68, 1.0 ), vec3( 1.0, 0.85, 0.66 ), towardCore * towardCore );
    return colour * band * dust * ( 0.35 + clouds * clouds * 1.8 ) * ( 0.35 + 0.95 * towardCore );
}

// The moon's disc: seas and craters on a sphere, lit from the side its phase says.
vec4 moonDisc( vec3 direction ) {
    float along = dot( direction, uMoon );
    if ( along <= 0.0 ) return vec4( 0.0 );
    vec2 p = vec2( dot( direction, uMoonRight ), dot( direction, uMoonUp ) ) / uMoonSine;
    float rr = dot( p, p );
    if ( rr >= 1.0 ) return vec4( 0.0 );
    vec3 n = vec3( p, sqrt( 1.0 - rr ) );
    float angle = ( uMoonPhase - 0.5 ) * 2.0 * 3.14159265358979;
    vec3 toSun = vec3( sin( angle ), 0.0, cos( angle ) );
    // The surface: dark seas, and bright rims round small craters.
    vec3 s = n * 3.1 + 7.0;
    float seas = smoothstep( 0.42, 0.62, skyFbm( s, 5 ) );
    float rough = skyFbm( n * 14.0 + 3.0, 4 );
    float albedo = mix( 0.95, 0.42, seas ) * ( 0.74 + 0.5 * rough );
    float lit = max( dot( n, toSun ), 0.0 );
    lit = pow( lit, 0.6 );
    // The dark side keeps a trace of light from the Earth.
    vec3 surface = albedo * ( lit * vec3( 1.0, 0.98, 0.94 ) + vec3( 0.012, 0.016, 0.024 ) );
    float edge = 1.0 - smoothstep( 0.96, 1.0, rr );
    return vec4( surface * edge, edge );
}
#endif

${SKY_VIEW_LOOKUP}
${TRANSMITTANCE_LOOKUP}

void main() {
    vec3 direction = normalize( vDirection );
    vec3 colour;
    if ( uPanoramaOn > 0.5 ) {
        // An image for a sky: wrapped round the dome.
        float longitude = atan( direction.z, direction.x ) + uPanoramaTurn;
        vec2 uv = vec2( fract( longitude / ( 2.0 * 3.14159265358979 ) + 0.5 ), asin( clamp( direction.y, - 1.0, 1.0 ) ) / 3.14159265358979 + 0.5 );
        colour = textureLod( uPanorama, uv, 0.0 ).rgb * uPanoramaScale;
    } else {
        colour = texture2D( uSkyView, skyViewUv( direction ) ).rgb * uSkyScale;
        // Under heavy cloud the air between is lit by the grey above it.
        if ( uSkyGrey > 0.0 ) colour = mix( colour, vec3( dot( colour, vec3( 0.2126, 0.7152, 0.0722 ) ) ), uSkyGrey );
    }
    #ifndef SKY_CAPTURE
    if ( uPanoramaOn < 0.5 ) {
        float mu = direction.y;
        vec3 through = textureLod( uTransmittance, transmittanceUvFor( uViewRadius, mu ), 0.0 ).rgb * smoothstep( - 0.004, 0.01, mu );
        if ( uStars > 0.003 ) {
            vec3 turned = uStarTurn * direction;
            vec3 night = starLayer( turned, 240.0, 0.05, 0.11, 0.8 ) + starLayer( turned, 95.0, 0.05, 0.07, 1.6 );
            if ( uMilkyWay > 0.003 ) night += milkyWay( turned ) * uMilkyWay * 0.11;
            colour += night * uStars * through;
        }
        vec4 moon = moonDisc( direction );
        if ( moon.a > 0.0 ) {
            // By day it fades out with its light; below the horizon the ground hides it.
            float seen = moon.a * clamp( dot( uMoonRadiance, vec3( 3.0 ) ), 0.0, 1.0 ) * smoothstep( - 0.004, 0.006, direction.y );
            colour = mix( colour, colour * 0.25 + moon.rgb * uMoonRadiance * through, seen );
        }
        // The sun's disc, darker at its rim, with its colour after the air.
        float along = dot( direction, uSun );
        if ( along > uSunEdge.x ) {
            float disc = smoothstep( uSunEdge.x, uSunEdge.y, along );
            float rim = sqrt( max( 0.0, 1.0 - ( 1.0 - along * along ) / max( 1.0 - uSunEdge.y * uSunEdge.y, 1e-9 ) ) );
            colour += uSunRadiance * through * disc * pow( vec3( rim ), vec3( 0.397, 0.503, 0.652 ) );
        }
    }
    #endif
    // Clouds in front of everything, from their own map of the sky.
    if ( uCloudsOn > 0.5 && direction.y > 0.0 ) {
        vec2 uv = direction.xz / ( 1.0 + direction.y ) * 0.5 + 0.5;
        // A small tent over the map, to smooth what is left of the ray march's noise.
        vec2 texel = uCloudTexel;
        vec4 cloud = ( texture2D( uClouds, uv ) * 2.0 + texture2D( uClouds, uv + vec2( texel.x, texel.y ) ) + texture2D( uClouds, uv + vec2( - texel.x, texel.y ) )
            + texture2D( uClouds, uv + vec2( texel.x, - texel.y ) ) + texture2D( uClouds, uv + vec2( - texel.x, - texel.y ) ) ) / 6.0;
        // They sink into the haze before the horizon, never ending at a line.
        float horizon = smoothstep( 0.0, 0.03, direction.y );
        colour = colour * mix( 1.0, cloud.a, horizon ) + cloud.rgb * uCloudScale * horizon;
        colour += uFlash * ( 1.0 - cloud.a ) * vec3( 0.75, 0.82, 1.0 ) * horizon * ( 0.5 + 0.8 * ( 1.0 - cloud.a ) );
    }
    if ( uFlatCover > 0.0 ) colour = mix( colour, uFlatCloud, uFlatCover * smoothstep( - 0.05, 0.1, direction.y ) );
    if ( uLowerSolid > 0.5 && direction.y < 0.0 ) colour = uLowerColor;
    gl_FragColor = vec4( colour, 1.0 );
    #ifndef SKY_CAPTURE
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // A long, smooth gradient would show bands in eight bits: a little noise, less than one step, hides them.
    gl_FragColor.rgb += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;
    #endif
}`;

/** Copies a table into a part of the scene's sky atlas. */
export const COPY_FRAGMENT = /* glsl */ `
uniform sampler2D uSource;
varying vec2 vUv;
void main() {
    gl_FragColor = textureLod( uSource, vUv, 0.0 );
}`;

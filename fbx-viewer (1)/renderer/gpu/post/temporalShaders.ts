import { POST_WGSL, SAFE_COLOUR_WGSL } from "./postShaders";

/**
 * THE TEMPORAL RESOLVE AND ITS OUTPUT
 *
 * Colour is gathered with its highlights compressed (each colour over one plus its brightest channel), so a single
 * very bright pixel weighs no more than its neighbours and filtering cannot ring around it. History stays compressed;
 * the output step expands it for the HDR effects that follow.
 *
 * History holds two pictures: the colour and how much sample weight it has gathered, and beside it the two things that
 * decide how far to trust it:
 *  - The farthest surface around this pixel last frame. A surface further away than all of them was behind something,
 *    and has no history of its own here, whatever colour lies there, so that history is dropped. The farthest, not the
 *    pixel's own: a thin line hit on one frame must not look as if it hid what is behind it, least of all at a small
 *    render scale, where one drawn pixel covers several output pixels.
 *  - How much contrast this pixel's surroundings have shown lately at an edge in depth. A line thinner than a pixel is
 *    only hit on some of the jittered frames; on the others the colours around it say it is not there, and clipping to
 *    them alone would wipe it, then bring it back. The remembered contrast keeps the box wide enough through those
 *    frames, and fades over one cycle of jitter. Only geometry holding still on screen earns it.
 *
 * The motion target holds every surface's whole motion, the camera's included. What the camera does not explain is the
 * surface's own, and only that counts as something having moved: the rest of a frame's motion comes from depth and
 * the two views, which is exact, where the target has been rounded to half floats.
 */

const COMPRESSION_WGSL = /* wgsl */ `
fn compressColour(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn expandColour(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3); }
`;

export const RESOLVE_WGSL = /* wgsl */ `
${POST_WGSL}
${SAFE_COLOUR_WGSL}
${COMPRESSION_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var depthMap: texture_depth_2d;
@group(0) @binding(3) var motionMap: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;
// r: the contrast remembered around each pixel; g: how far away the farthest surface around it stood.
@group(0) @binding(5) var companionHistory: texture_2d<f32>;
@group(0) @binding(6) var linearClamp: sampler;
@group(0) @binding(7) var resolvedOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var companionOut: texture_storage_2d<rgba16float, write>;

fn toYCoCg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

fn fromYCoCg(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

fn historyColour(uv: vec2f) -> vec3f {
  return textureSampleLevel(history, linearClamp, uv, 0.0).rgb;
}

// Five bilinear taps standing in for a sixteen-tap Catmull-Rom filter, which keeps history from softening.
fn sampleHistory(uv: vec2f) -> vec3f {
  let texel = 1.0 / u.outputSize;
  let position = uv * u.outputSize;
  let centre = floor(position - 0.5) + 0.5;
  let f = position - centre;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = -0.5 * f3 + f2 - 0.5 * f;
  let w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  let w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
  let w3 = 0.5 * f3 - 0.5 * f2;
  let w12 = w1 + w2;
  let tc12 = (centre + w2 / w12) * texel;
  let tc0 = (centre - 1.0) * texel;
  let tc3 = (centre + 2.0) * texel;
  let sum = historyColour(vec2f(tc12.x, tc0.y)) * (w12.x * w0.y)
    + historyColour(vec2f(tc0.x, tc12.y)) * (w0.x * w12.y)
    + historyColour(vec2f(tc12.x, tc12.y)) * (w12.x * w12.y)
    + historyColour(vec2f(tc3.x, tc12.y)) * (w3.x * w12.y)
    + historyColour(vec2f(tc12.x, tc3.y)) * (w12.x * w3.y);
  let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return clamp(sum / max(weight, 1e-4), vec3f(0.0), vec3f(1.0));
}

// Pulls a colour toward the centre of a box until it lies inside.
fn clipToBox(centre: vec3f, extent: vec3f, colour: vec3f) -> vec3f {
  let offset = colour - centre;
  let reach = abs(offset) / max(extent, vec3f(1e-5));
  let furthest = max(reach.x, max(reach.y, reach.z));
  return select(colour, centre + offset / furthest, furthest > 1.0);
}

// Distance along the view from reversed depth: its clip-space z is one minus twice the depth.
fn distanceOf(depth: f32) -> f32 {
  return u.depthToDistance.y / (1.0 - depth * 2.0 + u.depthToDistance.x);
}

// Where a surface stood in last frame's clip space, from where it stands in this frame's with w one.
fn beforeOf(uv: vec2f, depth: f32) -> vec4f {
  return u.reprojection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 1.0 - depth * 2.0, 1.0);
}

// How far the camera alone has carried this point on screen since last frame, in uv.
fn cameraVelocity(uv: vec2f, before: vec4f) -> vec2f {
  // Behind last frame's camera a surface has no place on its screen, and dividing would mirror it onto one.
  if (before.w <= 1e-6) { return vec2f(0.0); }
  let ndc = before.xy / before.w;
  return uv - vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// What of a surface's motion the camera does not explain, in uv; exactly zero when it has not moved of itself.
fn ownVelocity(velocity: vec2f, uv: vec2f, depth: f32) -> vec2f {
  // The sky and whatever else drew no motion: there is nothing here but the camera's.
  if (depth <= 0.0 || all(velocity == vec2f(0.0))) { return vec2f(0.0); }
  let before = beforeOf(uv, depth);
  if (before.w <= 1e-6) { return vec2f(0.0); }
  let own = velocity - cameraVelocity(uv, before);
  let pixels = own * u.outputSize;
  // The target is half floats: its rounding grows with the motion, and is no sign of anything moving.
  let slack = 0.02 + length(velocity * u.outputSize) / 256.0;
  return select(vec2f(0.0), own, dot(pixels, pixels) > slack * slack);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let outputPixels = vec2u(u.outputSize);
  if (id.x >= outputPixels.x || id.y >= outputPixels.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / u.outputSize;
  let inputPosition = uv * u.inputSize;
  let base = vec2i(floor(inputPosition));
  let last = vec2i(u.inputSize) - vec2i(1);

  // This frame's colour at this output pixel, each drawn pixel weighted by how near its sample fell, in output
  // pixels: a smaller picture lands few samples close to any one output pixel, and the ones that do are what rebuilds
  // its detail. Also the colours around it as a box to hold history to, and the nearest surface to take motion from.
  let toOutput = u.outputSize / u.inputSize;
  var gathered = vec3f(0.0);
  var gatheredWeight = 0.0;
  var nearestSample = 0.0;
  var moment1 = vec3f(0.0);
  var moment2 = vec3f(0.0);
  // Depth is reversed: the nearest is the largest.
  var closest = 0.0;
  var closestTexel = base;
  var farthestDepth = 1.0;
  var fastestObject = 0.0;
  var depths: array<f32, 9>;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let at = clamp(base + vec2i(x, y), vec2i(0), last);
      // A shader's NaN or a stray negative must not enter history, where it would spread and stay.
      let colour = compressColour(safeColour(textureLoad(current, at, 0).rgb));
      let away = (vec2f(at) + 0.5 - u.jitter - inputPosition) * toOutput;
      let weight = exp(-2.29 * dot(away, away));
      gathered += colour * weight;
      gatheredWeight += weight;
      nearestSample = max(nearestSample, weight);
      let box = toYCoCg(colour);
      moment1 += box;
      moment2 += box * box;
      let depth = textureLoad(depthMap, at, 0);
      depths[(x + 1) + (y + 1) * 3] = depth;
      if (depth > closest) {
        closest = depth;
        closestTexel = at;
      }
      farthestDepth = min(farthestDepth, depth);
      let atUv = (vec2f(at) + 0.5) / u.inputSize;
      let moved = ownVelocity(-textureLoad(motionMap, at, 0).rg, atUv, depth) * u.outputSize;
      fastestObject = max(fastestObject, dot(moved, moved));
    }
  }
  gathered /= max(gatheredWeight, 1e-4);

  let mean = moment1 / 9.0;
  let deviation = sqrt(max(moment2 / 9.0 - mean * mean, vec3f(0.0)));
  let farDistance = distanceOf(farthestDepth);
  // Raw depth runs in a straight line across any flat surface on screen, however steeply it is seen, so what bends a
  // line through this pixel is an edge. As a share of the distance, so it means the same near and far.
  let bend = max(
    max(abs(depths[3] + depths[5] - 2.0 * depths[4]), abs(depths[1] + depths[7] - 2.0 * depths[4])),
    max(abs(depths[0] + depths[8] - 2.0 * depths[4]), abs(depths[2] + depths[6] - 2.0 * depths[4]))
  ) * 2.0;
  var depthEdge = bend > 0.001;
  if (u.perspective > 0.5) { depthEdge = bend * distanceOf(closest) / abs(u.depthToDistance.y) > 0.003; }
  let objectNear = fastestObject > 0.0625; // a quarter of a pixel a frame

  let closestUv = (vec2f(closestTexel) + 0.5) / u.inputSize;
  let cameraBefore = beforeOf(closestUv, closest);
  let closestVelocity = -textureLoad(motionMap, closestTexel, 0).rg;
  let objectMoved = any(ownVelocity(closestVelocity, closestUv, closest) != vec2f(0.0));
  let velocity = select(cameraVelocity(closestUv, cameraBefore), closestVelocity, objectMoved);

  // Velocity comes from the nearest surface here, so this says whether what makes the edge is holding still. A tree
  // sliding across a still sky under a moving camera would otherwise leave its contrast on the sky.
  let speed = length(velocity * u.outputSize);
  var seenContrast = 0.0;
  if (depthEdge && !objectNear) { seenContrast = deviation.x * (1.0 - smoothstep(0.1, 0.75, speed)); }

  let historyUv = uv - velocity;
  var usable = u.hasHistory > 0.5 && (objectMoved || cameraBefore.w > 1e-6)
    && all(historyUv >= vec2f(0.0)) && all(historyUv <= vec2f(1.0));
  if (usable && !objectMoved && u.perspective > 0.5) {
    // Every surface around here last frame stood well in front of where this one stood: it was hidden.
    let corner = vec2i(floor(historyUv * u.outputSize - 0.5));
    let lastOutput = vec2i(u.outputSize) - vec2i(1);
    let farthest = max(
      max(
        textureLoad(companionHistory, clamp(corner, vec2i(0), lastOutput), 0).g,
        textureLoad(companionHistory, clamp(corner + vec2i(1, 0), vec2i(0), lastOutput), 0).g
      ),
      max(
        textureLoad(companionHistory, clamp(corner + vec2i(0, 1), vec2i(0), lastOutput), 0).g,
        textureLoad(companionHistory, clamp(corner + vec2i(1, 1), vec2i(0), lastOutput), 0).g
      )
    );
    // The matrix runs from clip space to clip space, so its w is last frame's distance over this frame's.
    if (farthest < cameraBefore.w * distanceOf(closest) * 0.97 - 0.02) { usable = false; }
  }
  if (!usable) {
    textureStore(resolvedOut, id.xy, vec4f(gathered, nearestSample));
    textureStore(companionOut, id.xy, vec4f(seenContrast, farDistance, 0.0, 1.0));
    return;
  }

  let motion = smoothstep(0.25, 4.0, speed);
  // Memory rides with the surface behind: under a moving view a silhouette slides across that surface, and what it
  // left there would hold the box open behind it as a wake. It is only good while things hold still, the camera
  // included: moving through the world leaves a far surface like the sky still on screen, while everything nearer
  // slides across it.
  let remembered = max(
    seenContrast,
    textureSampleLevel(companionHistory, linearClamp, historyUv, 0.0).r * u.contrastFade * (1.0 - motion) * u.cameraStillness
  );
  // A line hit by one sample of the nine shows a deviation of about a third of its contrast, so reaching three times
  // the remembered figure spans the whole way from the line's colour to what lies behind it.
  let extent = max(deviation * mix(u.clipSpread.x, u.clipSpread.y, motion), vec3f(remembered * mix(3.0, 1.0, motion)));
  let kept = clipToBox(mean, extent, toYCoCg(sampleHistory(historyUv)));

  // A running mean weighted by how near each frame's sample fell: a pixel just uncovered takes what it can get, then
  // good samples outweigh the rest. The floor keeps old samples from outstaying their welcome.
  let settled = textureSampleLevel(history, linearClamp, historyUv, 0.0).a;
  var share = max(nearestSample / max(settled + nearestSample, 1e-4), mix(u.blendFloor.x, u.blendFloor.y, motion) * nearestSample);
  // What moves is resampled every frame and softens; it leans on the new frame a little more.
  share = max(share, 0.16 * smoothstep(1.0, 24.0, speed));

  let colour = mix(fromYCoCg(kept), gathered, share);
  textureStore(resolvedOut, id.xy, vec4f(clamp(colour, vec3f(0.0), vec3f(1.0)), min(settled + nearestSample, 64.0)));
  textureStore(companionOut, id.xy, vec4f(remembered, farDistance, 0.0, 1.0));
}
`;

export const TEMPORAL_OUTPUT_WGSL = /* wgsl */ `
${POST_WGSL}
${COMPRESSION_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var resolved: texture_2d<f32>;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;

fn brightest(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(id.xy);
  let last = vec2i(size) - vec2i(1);
  let centre = textureLoad(resolved, at, 0).rgb;
  var colour = centre;
  if (u.sharpness > 0.0) {
    // Contrast-adaptive: sharpens by what the neighbourhood leaves room for, so edges do not overshoot.
    let north = textureLoad(resolved, clamp(at - vec2i(0, 1), vec2i(0), last), 0).rgb;
    let south = textureLoad(resolved, clamp(at + vec2i(0, 1), vec2i(0), last), 0).rgb;
    let east = textureLoad(resolved, clamp(at + vec2i(1, 0), vec2i(0), last), 0).rgb;
    let west = textureLoad(resolved, clamp(at - vec2i(1, 0), vec2i(0), last), 0).rgb;
    let lowest = min(brightest(centre), min(brightest(north), min(brightest(south), min(brightest(east), brightest(west)))));
    let highest = max(brightest(centre), max(brightest(north), max(brightest(south), max(brightest(east), brightest(west)))));
    let room = sqrt(clamp(min(lowest, 1.0 - highest) / max(highest, 1e-4), 0.0, 1.0));
    let lobe = -room * u.sharpness * 0.2;
    colour = clamp((centre + lobe * (north + south + east + west)) / (1.0 + 4.0 * lobe), vec3f(0.0), vec3f(1.0));
  }
  textureStore(writeTo, id.xy, vec4f(expandColour(colour), 1.0));
}
`;

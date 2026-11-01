// GLSL for each step of the terrain tutorial. The page shows these strings exactly as they are
// compiled, so every step builds its shaders from the same pieces and only adds what's new.

export type Displace = 'flat' | 'sine' | 'noise' | 'fbm';

export interface Step {
  id: number;
  title: string;
  text: string;
  displace: Displace;
  colour: boolean;
  light: boolean;
  water: boolean;
  wireframe: boolean;
  /** Controls that matter from this step on */
  controls: string[];
}

export const STEPS: Step[] = [
  {
    id: 1,
    title: 'A grid of points',
    text: 'Everything a GPU draws starts as triangles. This is a flat 20 × 20 square split into a grid of smaller squares, each made of two triangles. Their corners are called vertices. A vertex shader is a small program the GPU runs once for every vertex, many at a time in parallel. For now it only works out where each vertex appears on screen. The fragment shader then colours every pixel the triangles cover, here all the same colour. The wireframe view uses a 64 × 64 grid so the lines stay visible. The solid view, from step 5, uses 256 × 256: 66,049 vertices.',
    displace: 'flat',
    colour: false,
    light: false,
    water: false,
    wireframe: true,
    controls: [],
  },
  {
    id: 2,
    title: 'Move the points',
    text: 'Change a vertex’s y coordinate in the vertex shader and the grid bends. The height comes from sine waves. uTime is a uniform: a value JavaScript sends to the shader each frame, the same for every vertex. Changing it moves the waves without JavaScript touching a single vertex.',
    displace: 'sine',
    colour: false,
    light: false,
    water: false,
    wireframe: true,
    controls: ['height', 'animate'],
  },
  {
    id: 3,
    title: 'Noise',
    text: 'Sine waves are too regular to look like land. Noise is smooth randomness: give every point of a coarse grid a random value, then blend smoothly between them. A shader has no random number generator, so hash() makes a repeatable random-looking number from the coordinates instead. The same input always gives the same terrain.',
    displace: 'noise',
    colour: false,
    light: false,
    water: false,
    wireframe: true,
    controls: ['height', 'scale', 'seed'],
  },
  {
    id: 4,
    title: 'Layers of noise',
    text: 'Real landscapes have large hills with smaller bumps on them, and smaller bumps on those. Fractal noise adds layers, called octaves, of the same noise. Each layer is twice as detailed and half as tall as the one before. Then the result is stretched and squared, which flattens the valleys and sharpens the peaks.',
    displace: 'fbm',
    colour: false,
    light: false,
    water: false,
    wireframe: true,
    controls: ['height', 'scale', 'seed', 'octaves'],
  },
  {
    id: 5,
    title: 'Colour by height',
    text: 'Now the fragment shader colours each pixel by its height. A varying, vHeight, passes a value from the vertex shader to the fragment shader, blended across each triangle. smoothstep() fades from one colour band to the next: water, sand, grass, forest, rock and snow. The shape is still hard to read, because nothing is lit.',
    displace: 'fbm',
    colour: true,
    light: false,
    water: false,
    wireframe: false,
    controls: ['height', 'scale', 'seed', 'octaves', 'sea'],
  },
  {
    id: 6,
    title: 'Light and shade',
    text: 'To light a surface, the shader needs to know which way it faces: its normal. The vertex shader samples the height a short step away in two directions, which gives the slope, and the slope gives the normal. The fragment shader then brightens pixels that face the sun, the dot product of the normal and the sun’s direction.',
    displace: 'fbm',
    colour: true,
    light: true,
    water: false,
    wireframe: false,
    controls: ['height', 'scale', 'seed', 'octaves', 'sea', 'sun'],
  },
  {
    id: 7,
    title: 'Water and fog',
    text: 'A second, flat mesh at sea level gets its own shader. It works out how deep the water is by calling the same heightAt() function, then colours by depth, adds ripples from noise that drifts over time, and draws foam where the water is shallow. Both shaders also fade pixels towards the sky colour the further they are from the camera, so the far side looks further away. Rotate the view to see the fog move with the camera.',
    displace: 'fbm',
    colour: true,
    light: true,
    water: true,
    wireframe: false,
    controls: ['height', 'scale', 'seed', 'octaves', 'sea', 'sun', 'animate'],
  },
];

const NOISE = `// A repeatable random-looking number between 0 and 1 for any point
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value noise: random values at the corners of a grid, smoothly blended in between
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`;

const FBM = `// Fractal noise: octaves of noise, each twice as detailed and half as tall
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uOctaves) break;
    sum += amp * noise(p);
    total += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return sum / total;
}`;

function heightFunction(d: Displace) {
  switch (d) {
    case 'flat':
      return '';
    case 'sine':
      return `float heightAt(vec2 xz) {
  return sin(xz.x * 0.8 + uTime) * cos(xz.y * 0.6 + uTime * 0.7) * uHeight * 0.3;
}`;
    case 'noise':
      return `${NOISE}

float heightAt(vec2 xz) {
  return noise(xz / 20.0 * uScale + uSeed) * uHeight;
}`;
    case 'fbm':
      return `${NOISE}

${FBM}

float heightAt(vec2 xz) {
  float h = fbm(xz / 20.0 * uScale + uSeed);
  h = clamp((h - 0.25) / 0.55, 0.0, 1.0); // stretch to use the whole 0 to 1 range
  return h * h * uHeight;                 // squaring flattens valleys and sharpens peaks
}`;
  }
}

function heightUniforms(d: Displace) {
  const u: string[] = [];
  if (d === 'sine') u.push('uniform float uTime;');
  if (d !== 'flat') u.push('uniform float uHeight;');
  if (d === 'noise' || d === 'fbm') u.push('uniform float uScale;', 'uniform vec2 uSeed;');
  if (d === 'fbm') u.push('uniform int uOctaves;');
  return u;
}

const join = (...parts: (string | string[] | false)[]) =>
  parts
    .filter((p): p is string | string[] => p !== false && (Array.isArray(p) ? p.length > 0 : p !== ''))
    .map((p) => (Array.isArray(p) ? p.join('\n') : p))
    .join('\n\n');

export function terrainVertex(s: Step) {
  const varyings = [s.colour && 'varying float vHeight;', s.light && 'varying vec3 vNormal;', s.water && 'varying vec3 vWorldPos;'].filter(Boolean) as string[];
  const body = [
    '  vec3 pos = position;',
    s.displace !== 'flat' && '  pos.y = heightAt(pos.xz);',
    s.light &&
      `
  // Heights a short step away give the slope, and the slope gives the normal
  float e = 0.05;
  float hx = heightAt(pos.xz + vec2(e, 0.0));
  float hz = heightAt(pos.xz + vec2(0.0, e));
  vNormal = normalize(vec3(pos.y - hx, e, pos.y - hz));`,
    s.colour && '\n  vHeight = pos.y;',
    '  vec4 world = modelMatrix * vec4(pos, 1.0);',
    s.water && '  vWorldPos = world.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * world;',
  ].filter(Boolean);
  return join(
    '// three.js adds the position attribute and the camera matrices above this line',
    heightUniforms(s.displace),
    varyings,
    heightFunction(s.displace),
    `void main() {\n${body.join('\n')}\n}`
  );
}

const COLOURS = `vec3 terrainColour(float t) {
  vec3 deep = vec3(0.16, 0.30, 0.42);
  vec3 sand = vec3(0.85, 0.77, 0.56);
  vec3 grass = vec3(0.35, 0.56, 0.31);
  vec3 forest = vec3(0.22, 0.40, 0.22);
  vec3 rock = vec3(0.48, 0.44, 0.41);
  vec3 snow = vec3(0.95, 0.95, 0.93);
  vec3 c = deep;
  c = mix(c, sand, smoothstep(uSea - 0.02, uSea, t));
  c = mix(c, grass, smoothstep(uSea + 0.02, uSea + 0.06, t));
  c = mix(c, forest, smoothstep(0.45, 0.6, t));
  c = mix(c, rock, smoothstep(0.62, 0.7, t));
  c = mix(c, snow, smoothstep(0.78, 0.84, t));
  return c;
}`;

const FOG = `  // Fog: fade towards the sky colour with distance from the camera
  float fog = smoothstep(uFogNear, uFogFar, distance(vWorldPos, cameraPosition));
  colour = mix(colour, uFogColor, fog);`;

const FOG_UNIFORMS = ['uniform vec3 uFogColor;', 'uniform float uFogNear;', 'uniform float uFogFar;'];

export function terrainFragment(s: Step) {
  if (!s.colour) {
    return join('void main() {\n  gl_FragColor = vec4(0.56, 0.72, 0.69, 1.0);\n}');
  }
  const uniforms = ['uniform float uHeight;', 'uniform float uSea;', ...(s.light ? ['uniform vec3 uSunDir;'] : []), ...(s.water ? FOG_UNIFORMS : [])];
  const varyings = ['varying float vHeight;', ...(s.light ? ['varying vec3 vNormal;'] : []), ...(s.water ? ['varying vec3 vWorldPos;'] : [])];
  const body = [
    '  float t = vHeight / uHeight;',
    '  vec3 colour = terrainColour(t);',
    s.light &&
      `
  // Light: brighter where the surface faces the sun
  float light = max(dot(normalize(vNormal), uSunDir), 0.0);
  colour *= 0.35 + 0.75 * light;`,
    s.water && `\n${FOG}`,
    '\n  gl_FragColor = vec4(colour, 1.0);',
  ].filter(Boolean);
  return join(uniforms, varyings, COLOURS, `void main() {\n${body.join('\n')}\n}`);
}

export const WATER_VERTEX = join(
  '// three.js adds the position attribute and the camera matrices above this line',
  'varying vec3 vWorldPos;',
  `void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`
);

export const WATER_FRAGMENT = join(
  ['uniform float uTime;', 'uniform float uHeight;', 'uniform float uScale;', 'uniform vec2 uSeed;', 'uniform int uOctaves;', ...FOG_UNIFORMS],
  'varying vec3 vWorldPos;',
  heightFunction('fbm'),
  `void main() {
  // How deep the water is here: sea level minus the height of the land below
  float depth = vWorldPos.y - heightAt(vWorldPos.xz);
  if (depth < 0.0) discard; // the land is above the water here, so draw nothing

  vec3 shallow = vec3(0.30, 0.62, 0.66);
  vec3 deep = vec3(0.07, 0.20, 0.33);
  vec3 colour = mix(shallow, deep, smoothstep(0.0, 0.8, depth));

  // Ripples: fine noise drifting over time
  float ripple = noise(vWorldPos.xz * 3.0 + vec2(uTime * 0.6, uTime * 0.4));
  colour += 0.08 * ripple;

  // Foam along the shore, where the water is shallowest
  colour = mix(colour, vec3(0.92), 1.0 - smoothstep(0.0, 0.06, depth));

${FOG}

  gl_FragColor = vec4(colour, 0.9);
}`
);

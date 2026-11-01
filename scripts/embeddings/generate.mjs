// Generates src/data/embeddings.json for the embedding space explorer.
//
// Not part of the site build: it needs @huggingface/transformers, which downloads the
// all-MiniLM-L6-v2 model on first run, and umap-js. To regenerate the data:
//
//   mkdir tmp-embed && cd tmp-embed && npm init -y && npm install @huggingface/transformers@3 umap-js@1
//   cp ../scripts/embeddings/*.mjs . && node generate.mjs ../src/data/embeddings.json

import { writeFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';
import { UMAP } from 'umap-js';
import { CATEGORIES, PHRASES, QUERIES } from './phrases.mjs';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const out = process.argv[2];
if (!out) throw new Error('Usage: node generate.mjs <output.json>');

const items = [
  ...CATEGORIES.flatMap((c) => PHRASES[c.id].map((text) => ({ text, category: c.id, query: false }))),
  ...QUERIES.map((text) => ({ text, category: null, query: true })),
];

// 1. Embed: mean-pool the token vectors and normalise to length 1, as the model is meant to be used
const embed = await pipeline('feature-extraction', MODEL);
const result = await embed(
  items.map((i) => i.text),
  { pooling: 'mean', normalize: true }
);
const dims = result.dims[1];
const vectors = items.map((_, i) => Array.from(result.data.slice(i * dims, (i + 1) * dims)));
console.log(`Embedded ${items.length} texts into ${dims} dimensions`);

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// 2. Project the phrases (not the queries) to 3D with UMAP, which tries to keep each phrase near its
// nearest neighbours. A seeded random number generator makes the layout the same on every run.
const phraseIdx = items.map((it, i) => (it.query ? -1 : i)).filter((i) => i >= 0);
let seed = 42;
const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const umap = new UMAP({ nComponents: 3, nNeighbors: 15, minDist: 0.3, random, distanceFn: (a, b) => 1 - dot(a, b) });
const phraseCoords = umap.fit(phraseIdx.map((i) => vectors[i]));

// Queries are placed with the fitted model, so they land among the phrases they resemble
const coords = items.map((it, i) => (it.query ? umap.transform([vectors[i]])[0] : phraseCoords[phraseIdx.indexOf(i)]));
const centre = [0, 1, 2].map((k) => phraseCoords.reduce((s, c) => s + c[k], 0) / phraseCoords.length);
const maxAbs = Math.max(...phraseCoords.flatMap((c) => c.map((x, k) => Math.abs(x - centre[k]))));
const scale = 8 / maxAbs;
coords.forEach((c) => c.forEach((x, k) => (c[k] = x - centre[k])));

// How often a phrase's 5 nearest neighbours share its topic, in full 384 dimensions and in 3D
const cosineFull = (a, b) => dot(vectors[a], vectors[b]);
const closeness3d = (a, b) => -Math.hypot(...coords[a].map((x, k) => x - coords[b][k]));
const agreement = (metric) => {
  let same = 0;
  for (const i of phraseIdx) {
    const near = phraseIdx.filter((j) => j !== i).sort((a, b) => metric(i, b) - metric(i, a)).slice(0, 5);
    same += near.filter((j) => items[j].category === items[i].category).length;
  }
  return same / (phraseIdx.length * 5);
};
const neighbourAgreement = { full: agreement(cosineFull), projected: agreement(closeness3d) };
console.log(`Nearest 5 share the topic: ${(neighbourAgreement.full * 100).toFixed(1)}% in full, ${(neighbourAgreement.projected * 100).toFixed(1)}% in 3D`);

// 3. Store each vector as 8-bit whole numbers (-127 to 127) plus a scale: about 4 times smaller than
// 32-bit floats, and cosine similarity barely changes, because rounding barely changes the direction
const quantised = new Int8Array(items.length * dims);
const scales = vectors.map((v, i) => {
  const m = Math.max(...v.map(Math.abs));
  v.forEach((x, d) => (quantised[i * dims + d] = Math.round((x / m) * 127)));
  return +(m / 127).toPrecision(6);
});

// Measure how much rounding changes the similarities
const q = (i) => Array.from(quantised.slice(i * dims, (i + 1) * dims));
const cosine = (a, b) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));
let worst = 0;
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) worst = Math.max(worst, Math.abs(cosine(vectors[i], vectors[j]) - cosine(q(i), q(j))));
}
console.log(`Largest change in cosine similarity from 8-bit storage: ${worst.toFixed(4)}`);

writeFileSync(
  out,
  JSON.stringify({
    model: 'all-MiniLM-L6-v2',
    dims,
    projection: { method: 'UMAP', nNeighbors: 15, minDist: 0.3 },
    neighbourAgreement: { full: +neighbourAgreement.full.toFixed(3), projected: +neighbourAgreement.projected.toFixed(3) },
    quantisationError: +worst.toFixed(4),
    categories: CATEGORIES,
    items: items.map((it, i) => ({
      text: it.text,
      category: it.category,
      query: it.query,
      position: coords[i].map((x) => +(x * scale).toFixed(3)),
      scale: scales[i],
    })),
    vectors: Buffer.from(quantised.buffer).toString('base64'),
  })
);
console.log(`Wrote ${out}`);

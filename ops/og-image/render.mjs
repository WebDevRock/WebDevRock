// Renders the default social share image: node ops/og-image/render.mjs
// Uses sharp, which Astro already installs for image processing.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./og-default.svg', import.meta.url));
const target = fileURLToPath(new URL('../../public/og-default.png', import.meta.url));

await sharp(source).png({ compressionLevel: 9 }).toFile(target);
console.log(`Wrote ${target}`);

import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://webdevrock.uk',
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      // Colours come from the --syn-* tokens via src/styles/content.css
      theme: 'css-variables',
      wrap: true
    }
  }
});

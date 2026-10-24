import type { APIRoute } from 'astro';
import { getContentPages, llmsIndex } from '../lib/llms';

// https://llmstxt.org: a Markdown index of the site for AI tools
export const GET: APIRoute = () =>
  new Response(llmsIndex(getContentPages()), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

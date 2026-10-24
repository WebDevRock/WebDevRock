import type { APIRoute } from 'astro';
import { getContentPages, llmsFull } from '../lib/llms';

// Every content page as Markdown in one file
export const GET: APIRoute = () =>
  new Response(llmsFull(getContentPages()), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

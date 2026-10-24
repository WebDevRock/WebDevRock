import type { APIRoute, GetStaticPaths } from 'astro';
import { getContentPages, toMarkdown, type ContentPage } from '../../lib/llms';

// A clean Markdown copy of each content page, e.g. /snippets/sql-bulk-update-join.md
export const getStaticPaths = (() =>
  getContentPages().map((page) => ({
    params: { section: page.section, slug: page.slug },
    props: { page },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: ContentPage }> = ({ props }) =>
  new Response(toMarkdown(props.page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });

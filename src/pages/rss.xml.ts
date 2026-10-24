// RSS feed of every content page, newest first. Pages only have an "updated" date, so that is used as the
// publish date: readers identify items by link, so an updated page moves up the feed without appearing twice.
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { byUpdated, getContentPages, getSection } from '../lib/content';
import { SITE_SUMMARY } from '../lib/llms';

export function GET(context: APIContext) {
  const pages = getContentPages().sort(byUpdated);

  return rss({
    title: 'WebDevRock',
    description: SITE_SUMMARY,
    site: context.site!,
    items: pages.map((page) => ({
      title: page.frontmatter.title,
      link: page.path,
      description: page.frontmatter.description,
      pubDate: page.frontmatter.updated ? new Date(page.frontmatter.updated) : undefined,
      categories: [getSection(page.section).singular, ...(page.frontmatter.tags ?? [])],
    })),
    customData: '<language>en-gb</language>',
    trailingSlash: true,
  });
}

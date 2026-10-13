// Arca article IDs increase globally. A watermark also prevents old posts removed
// by the retention limit from being announced again when they reappear.
export class NewArticleTracker {
  #highest = null;

  constructor(articles = []) { this.observe(articles); }

  observe(articles) {
    const candidates = [...new Map(articles.filter((article) =>
      typeof article?.id === 'string' && /^\d{1,30}$/.test(article.id) &&
      typeof article.title === 'string' && article.title.trim() &&
      !article.author?.trim().startsWith('*') && !article.isNotice,
    ).map((article) => [article.id, article])).values()]
      .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
    if (!candidates.length) return [];
    const previous = this.#highest;
    const highest = BigInt(candidates[0].id);
    if (previous === null || highest > previous) this.#highest = highest;
    if (previous === null) return [];
    return candidates.filter((article) => BigInt(article.id) > previous).map(({ id, title, category, author }) => ({
      id, title: title.slice(0, 300), category: typeof category === 'string' ? category.slice(0, 100) : null,
      author: typeof author === 'string' ? author.slice(0, 80) : null,
    }));
  }
}

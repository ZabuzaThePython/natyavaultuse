/**
 * Comparing a running page with the build now published at `/index.html`.
 *
 * Split out from the watcher so the parsing rule can be tested without a
 * browser: getting this wrong either never offers a reload or offers one on
 * every check.
 */

function pathOf(url: string): string {
  try {
    return new URL(url, "https://natyavault.invalid").pathname;
  } catch {
    return url;
  }
}

/**
 * Whether the published `html` boots a different entry script than
 * `currentSrc` — the module this page is actually running.
 *
 * Vite names the entry `index-<hash>.js`, and that hash changes whenever the
 * app's code does, so a different path means a newer build.
 */
export function isNewBuild(currentSrc: string | null, html: string): boolean {
  if (!currentSrc) return false;
  const match =
    /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i.exec(html) ??
    /<script[^>]+src=["']([^"']+)["'][^>]+type=["']module["']/i.exec(html);
  if (!match) return false;
  return pathOf(match[1]) !== pathOf(currentSrc);
}

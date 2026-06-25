/**
 * Live GitHub project lookup for the assistant-mode chat. Fetches the owner's
 * public repos and distills them into a compact PROJECTS block injected into the
 * system prompt, so the assistant answers about REAL projects instead of guessing.
 *
 * Cached at the edge (Cache API) for several hours to stay well under GitHub's
 * unauthenticated rate limit; set GITHUB_TOKEN for a higher limit. Only the
 * owner's own (non-fork, non-archived) repos are used, ranked by stars then
 * recency, top few.
 */
export interface GithubEnv {
  GITHUB_USER?: string;
  GITHUB_TOKEN?: string; // optional; raises the API rate limit
}

export interface GhRepo {
  name: string;
  description?: string | null;
  language?: string | null;
  homepage?: string | null;
  fork?: boolean;
  archived?: boolean;
  stargazers_count?: number;
  pushed_at?: string;
}

/** Pure: pick the owner's own repos and format them as prompt lines. */
export function formatProjects(repos: GhRepo[], owner: string, max = 8): string {
  const own = repos
    .filter((r) => r && r.name && !r.fork && !r.archived && r.name.toLowerCase() !== owner.toLowerCase())
    .sort((a, b) =>
      (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0) ||
      Date.parse(b.pushed_at ?? '') - Date.parse(a.pushed_at ?? ''),
    )
    .slice(0, max);
  return own
    .map((r) => {
      const lang = r.language ? ` [${r.language}]` : '';
      const desc = r.description ? ` — ${r.description.trim()}` : '';
      const home = r.homepage ? ` (${r.homepage})` : '';
      return `- ${r.name}${lang}${desc}${home}`;
    })
    .join('\n');
}

interface CtxLike { waitUntil(p: Promise<unknown>): void }

/** Fetch + cache the owner's projects as a formatted block; '' on any failure. */
export async function fetchOwnerProjects(env: GithubEnv, ctx: CtxLike): Promise<string> {
  const user = (env.GITHUB_USER ?? '').trim();
  if (!user) return '';
  const cacheKey = new Request(`https://availcal.internal/gh-projects/${encodeURIComponent(user)}`);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.text();
  }
  let out = '';
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'availcal-chat' };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`, { headers });
    if (res.ok) out = formatProjects((await res.json()) as GhRepo[], user);
  } catch {
    out = '';
  }
  if (out && cache) {
    const resp = new Response(out, { headers: { 'Cache-Control': 'max-age=21600' } }); // 6h
    ctx.waitUntil(cache.put(cacheKey, resp));
  }
  return out;
}

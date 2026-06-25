import { describe, expect, it } from 'vitest';

import { formatProjects, type GhRepo } from '../src/github';

describe('formatProjects', () => {
  const repos: GhRepo[] = [
    { name: 'cal-hub', description: 'Availability planning', language: 'TypeScript', homepage: 'https://availability.mendelg.tech', fork: false, stargazers_count: 1, pushed_at: '2026-06-25T00:00:00Z' },
    { name: 'some-fork', description: 'forked thing', language: 'Go', fork: true, stargazers_count: 9, pushed_at: '2026-06-20T00:00:00Z' },
    { name: 'grabskimm', description: 'profile readme', fork: false, stargazers_count: 0, pushed_at: '2025-07-28T00:00:00Z' },
    { name: 'aws-labs', description: 'Security labs', language: 'HCL', fork: false, stargazers_count: 1, pushed_at: '2025-11-28T00:00:00Z' },
    { name: 'archived-thing', description: 'old', fork: false, archived: true, stargazers_count: 5, pushed_at: '2024-01-01T00:00:00Z' },
  ];

  it('keeps only own (non-fork, non-archived) repos and excludes the profile repo', () => {
    const out = formatProjects(repos, 'grabskimm');
    expect(out).toContain('cal-hub');
    expect(out).toContain('aws-labs');
    expect(out).not.toContain('some-fork'); // fork
    expect(out).not.toContain('archived-thing'); // archived
    expect(out).not.toContain('profile readme'); // name === owner
  });

  it('formats lang, description, and homepage and ranks by stars then recency', () => {
    const out = formatProjects(repos, 'grabskimm');
    const lines = out.split('\n');
    // cal-hub and aws-labs both have 1 star; cal-hub pushed more recently -> first.
    expect(lines[0]).toBe('- cal-hub [TypeScript] — Availability planning (https://availability.mendelg.tech)');
    expect(lines[1]).toBe('- aws-labs [HCL] — Security labs');
  });

  it('respects the max cap', () => {
    const many: GhRepo[] = Array.from({ length: 12 }, (_, i) => ({ name: 'r' + i, fork: false, stargazers_count: i, pushed_at: '2026-01-01T00:00:00Z' }));
    expect(formatProjects(many, 'owner', 3).split('\n').length).toBe(3);
  });
});

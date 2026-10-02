/**
 * IssueSource over the container's GitHub client: the linked issue (title and body),
 * raced against a deadline. Best effort — any failure (no token, not found, network,
 * timeout) is `null`, which the service records as `linked_issue/fetch_failed`.
 */
import type { GitHubClient } from '@devdigest/shared';
import type { IssueSource } from '../application/ports.js';
import { ISSUE_FETCH_TIMEOUT_MS } from '../domain/constants.js';

export interface GitHubIssueSourceDeps {
  github: () => Promise<GitHubClient>;
  /** Tests shorten it. */
  timeoutMs?: number;
}

export class GitHubIssueSource implements IssueSource {
  constructor(private readonly deps: GitHubIssueSourceDeps) {}

  async fetch(repo: { owner: string; name: string }, issueNumber: number) {
    const ms = this.deps.timeoutMs ?? ISSUE_FETCH_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    const read = (async () => {
      const github = await this.deps.github();
      const issue = await github.getIssue(repo, issueNumber);
      return { number: issue.number, title: issue.title, body: issue.body ?? null };
    })().catch(() => null);
    try {
      return await Promise.race([read, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

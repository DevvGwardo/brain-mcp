import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import type { BrainDB } from '../db.js';

function git(args: string[], cwd: string, opts: { encoding?: 'utf-8'; stdio?: any; maxBuffer?: number } = {}): string {
  const out = execFileSync('git', args, {
    cwd,
    encoding: opts.encoding ?? 'utf-8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  });
  return String(out);
}

function gitTry(args: string[], cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

// ── Schema helpers ──
const cNum = () => z.preprocess(
  (v) => typeof v === 'string' && v.trim() !== '' ? Number(v) : v,
  z.number(),
);
const cBool = () => z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.toLowerCase().trim();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    return v;
  },
  z.boolean(),
);
const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : v;
    } catch {
      return v;
    }
  },
  z.array(item),
);

export interface GitToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  sh: (value: string) => string;
}

export function registerGitTools(
  server: { tool: (name: string, description: string, schema: any, handler: (params: any) => Promise<any>) => void },
  options: GitToolsOptions,
) {
  const { db, room, ensureSession, sh } = options;

  // ── commit ──

  server.tool(
    'commit',
    `Analyze unstaged changes, determine a conventional commit type, generate a commit message,
and stage + commit the changes. Uses git diff to understand what changed, then generates
a conventional commit message (feat, fix, docs, refactor, test, chore, etc.).

Works in any language. Run from the repository root.`,
    {
      message: z.string().optional().describe('Commit message override. If not provided, a conventional commit message is auto-generated from the diff.'),
      files: cArr(z.string()).optional().describe('Specific files to stage and commit. If not provided, commits all unstaged changes.'),
      no_verify: cBool().optional().describe('Pass --no-verify to bypass git hooks (default: false)'),
      amend: cBool().optional().describe('Amend the previous commit instead of creating a new one (default: false)'),
    },
    async ({ message, files, no_verify, amend }) => {
      ensureSession();

      // Get the diff
      const diffArgs: string[] = ['diff', '--cached'];
      if (!files) {
        // Stage everything first so we get a meaningful diff
        try { git(['add', '-A'], room); } catch { /* may fail if nothing to add */ }
      } else {
        diffArgs.push(...files);
        // Stage only specified files
        for (const f of files) {
          try { git(['add', f], room); } catch { /* ignore */ }
        }
      }

      let diff = '';
      try {
        diff = git(diffArgs, room);
      } catch (e: any) {
        const errMsg = e.stderr || e.message || '';
        if (errMsg.includes('empty') || errMsg.includes('no changes')) {
          // Nothing staged — try unstaged diff
          const unstagedDiff = git(['diff'], room);
          if (!unstagedDiff.trim()) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: 'No changes to commit. Stage files first with git add.' }) }] };
          }
          // Stage it
          git(['add', '-A'], room);
          diff = unstagedDiff;
        } else {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: `Git error: ${errMsg}` }) }] };
        }
      }

      // Get list of changed files
      let changedFiles: string[] = [];
      try {
        const statusOutput = git(['diff', '--cached', '--name-only'], room);
        changedFiles = statusOutput.trim().split('\n').filter(f => f);
      } catch { /* ignore */ }

      // Detect what changed (for commit type)
      const hasTests = changedFiles.some(f => f.includes('test') || f.includes('spec') || f.includes('__tests__'));
      const hasDocs = changedFiles.some(f => f.includes('README') || f.includes('docs') || f.includes('.md'));
      const hasConfig = changedFiles.some(f => f.includes('package.json') || f.includes('tsconfig') || f.includes('.yml') || f.includes('.yaml') || f.includes('Cargo.toml') || f.includes('pyproject.toml'));
      const hasSrc = changedFiles.some(f => !f.includes('test') && !f.includes('docs') && !f.includes('README') && (f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.rs') || f.endsWith('.go')));

      let commitType = 'chore';
      if (hasSrc) {
        // Heuristic: check diff size and patterns
        const addedLines = (diff.match(/^\+[^+]/gm) || []).length;
        const removedLines = (diff.match(/^-[^-]/gm) || []).length;
        if (diff.includes('fix') || diff.includes('bug') || diff.includes('FIX') || diff.includes('FIXME')) commitType = 'fix';
        else if (diff.includes('feat') || diff.includes('Feature') || addedLines > 50) commitType = 'feat';
        else commitType = 'refactor';
      } else if (hasTests) commitType = 'test';
      else if (hasDocs) commitType = 'docs';
      else if (hasConfig) commitType = 'chore';

      // Generate commit message if not provided
      let commitMsg = message;
      if (!commitMsg) {
        const scope = changedFiles.length === 1
          ? changedFiles[0].split('/')[0].replace(/\.[^.]+$/, '')
          : changedFiles.length > 4 ? 'core' : changedFiles.slice(0, 2).map(f => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i).join(',');

        const shortDesc = changedFiles.length === 1
          ? changedFiles[0].replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')
          : changedFiles.length <= 3
            ? changedFiles.map(f => f.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')).join(', ')
            : `${changedFiles.slice(0, 2).map(f => f.split('/')[0]).join(', ')} and ${changedFiles.length - 2} more`;

        commitMsg = `${commitType}${scope !== 'core' ? `(${scope})` : ''}: ${shortDesc}`;
      }

      // Build git command
      const commitArgs: string[] = ['commit'];
      if (no_verify) commitArgs.push('--no-verify');
      if (amend) commitArgs.push('--amend');
      commitArgs.push('-m', commitMsg);

      let commitHash = '';
      let commitError = '';
      try {
        const out = git(commitArgs, room);
        // Extract hash from output
        const hashMatch = out.match(/\[([a-f0-9]+)\s/);
        commitHash = hashMatch ? hashMatch[1] : '';
      } catch (e: any) {
        commitError = e.stderr || e.message;
      }

      if (commitError.includes('nothing to commit')) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: 'Nothing to commit. Stage changes with git add first.' }) }] };
      }
      if (commitError) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ committed: false, error: `Commit failed: ${commitError}` }) }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            committed: true,
            hash: commitHash,
            message: commitMsg,
            type: commitType,
            files: changedFiles,
            amend,
          }, null, 2),
        }],
      };
    }
  );

  // ── pr ──

  server.tool(
    'pr',
    `Create a GitHub pull request from the current branch. Reads recent commit messages
to build the PR body. Supports assigning reviewers, linking issues, and setting labels.
Uses the gh CLI — requires GitHub CLI to be installed and authenticated.`,
    {
      title: z.string().optional().describe('PR title. Auto-generated from commits if not provided.'),
      body: z.string().optional().describe('PR body/description. Auto-generated from commits if not provided.'),
      base: z.string().optional().describe('Base branch to merge into (default: detected from remote tracking branch or "main").'),
      reviewers: cArr(z.string()).optional().describe('GitHub usernames or team slugs to request as reviewers.'),
      labels: cArr(z.string()).optional().describe('Labels to apply to the PR.'),
      issue: z.string().optional().describe('Issue number to link (e.g. "closes #123").'),
      draft: cBool().optional().describe('Create as a draft PR (default: false).'),
      repo: z.string().optional().describe('Repository in "owner/repo" format. Detected from git remote if not provided.'),
    },
    async ({ title, body, base, reviewers, labels, issue, draft, repo }) => {
      ensureSession();

      // Get current branch
      let branch = '';
      try {
        branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], room).trim();
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: `Not a git repo: ${e.message}` }) }] };
      }
      if (branch === 'HEAD') {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: 'Detached HEAD — cannot create PR from a commit directly.' }) }] };
      }

      // Detect repo
      let repoSlug = repo;
      if (!repoSlug) {
        const remote =
          gitTry(['remote', 'get-url', 'origin'], room) ||
          gitTry(['remote', 'get-url', 'upstream'], room) ||
          '';
        const match = remote.trim().match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (match) repoSlug = match[1];
      }
      if (!repoSlug) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: 'Could not detect repo. Provide --repo in "owner/repo" format.' }) }] };
      }

      // Get base branch
      let baseBranch = base;
      if (!baseBranch) {
        const headRef = gitTry(['rev-parse', '--abbrev-ref', 'origin/HEAD'], room);
        baseBranch = headRef ? headRef.trim().replace('origin/', '') : 'main';
      }

      // Auto-generate title from commits if not provided
      let prTitle = title;
      if (!prTitle) {
        try {
          const commits = git(['log', branch, `^${baseBranch}`, '--oneline', '-10'], room);
          const lines = commits.trim().split('\n').filter(l => l);
          if (lines.length > 0) {
            // Strip the hash prefix to get the message
            const lastCommit = lines[lines.length - 1].replace(/^[a-f0-9]+\s+/, '');
            prTitle = lastCommit;
          }
        } catch { /* use branch name as fallback */ }
        if (!prTitle) prTitle = branch.replace(/[_-]/g, ' ');
      }

      // Auto-generate body from commit messages
      let prBody = body;
      if (!prBody) {
        try {
          const commits = git(['log', branch, `^${baseBranch}`, '--oneline', '-20'], room);
          const lines = commits.trim().split('\n').map(l => l.replace(/^[a-f0-9]+\s+/, '').trim());
          if (lines.length > 0) {
            const changelog = lines.map(l => `- ${l}`).join('\n');
            prBody = `## Summary\n\n${changelog}\n\n## Changes\n\n<!-- Add description of changes here -->\n`;
          }
        } catch { /* empty body */ }
      }

      // Build gh pr create argv
      const ghArgs: string[] = ['pr', 'create', '-R', repoSlug, '--title', prTitle, '--base', baseBranch];
      if (prBody) ghArgs.push('--body', prBody);
      if (reviewers && reviewers.length > 0) {
        for (const r of reviewers) ghArgs.push('--reviewer', r);
      }
      if (labels && labels.length > 0) {
        for (const l of labels) ghArgs.push('--label', l);
      }
      if (draft) ghArgs.push('--draft');
      if (issue) {
        const issueRef = issue.startsWith('#') ? issue : `#${issue}`;
        ghArgs.push('--assignee', '@me', '--link', issueRef);
      }

      let prUrl = '';
      let prNumber = '';
      let prError = '';
      try {
        const out = execFileSync('gh', ghArgs, { encoding: 'utf-8', cwd: room, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
        // gh outputs the PR URL
        const urlMatch = out.match(/https:\/\/github\.com\/[^\s]+/);
        if (urlMatch) prUrl = urlMatch[0];
        const numMatch = out.match(/#(\d+)/);
        if (numMatch) prNumber = numMatch[1];
        // If gh returned nothing useful, try to fetch the PR
        if (!prUrl) {
          const listOut = execFileSync('gh', ['pr', 'list', '-R', repoSlug, '--head', branch, '--json', 'number,url', '--jq', '.[0]'], { encoding: 'utf-8', cwd: room, stdio: ['ignore', 'pipe', 'pipe'] });
          const prInfo = JSON.parse(listOut);
          if (prInfo) { prUrl = prInfo.url; prNumber = String(prInfo.number); }
        }
      } catch (e: any) {
        prError = e.stderr || e.message;
      }

      if (prError && !prUrl) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ created: false, error: `gh PR create failed: ${prError}` }) }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            created: true,
            url: prUrl,
            number: prNumber,
            title: prTitle,
            base: baseBranch,
            head: branch,
            repo: repoSlug,
            reviewers: reviewers || [],
            labels: labels || [],
          }, null, 2),
        }],
      };
    }
  );

  // ── clean_branches ──

  server.tool(
    'clean_branches',
    `Prune local branches whose upstream is gone (merged/dead branches), and clean up
unused git worktrees. Requires no arguments — safely identifies stale branches
and reports what would be deleted before acting.`,
    {
      dry_run: cBool().optional().describe('Show what would be deleted without actually deleting (default: true)'),
      delete_worktrees: cBool().optional().describe('Also clean up stale git worktrees (default: false)'),
      force: cBool().optional().describe('Use -D instead of -d for branch deletion (default: false)'),
    },
    async ({ dry_run: isDryRun, delete_worktrees, force }) => {
      ensureSession();
      const dryRun = isDryRun !== false; // default true
      const prefix = dryRun ? '[DRY RUN] Would delete' : 'Deleted';

      const results: string[] = [];
      const errors: string[] = [];

      // 1. Prune remote references
      try {
        git(['fetch', '--prune'], room);
        results.push('Pruned remote references');
      } catch (e: any) {
        errors.push(`git fetch --prune: ${e.message}`);
      }

      // 2. Find gone branches
      let goneBranches: string[] = [];
      try {
        const out = git(['branch', '-vv'], room);
        goneBranches = out
          .split('\n')
          .filter(line => line.includes(': gone]'))
          .map(line => line.trim().replace(/^\*\s+/, '').split(/\s+/)[0])
          .filter(b => b && b !== 'HEAD');
        // Filter out current branch
        const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], room).trim();
        goneBranches = goneBranches.filter(b => b !== current);
      } catch (e: any) {
        errors.push(`git branch -vv: ${e.message}`);
      }

      const deletedBranches: string[] = [];
      const skippedBranches: string[] = [];

      if (goneBranches.length > 0) {
        for (const branch of goneBranches) {
          try {
            git(['branch', force ? '-D' : '-d', branch], room);
            deletedBranches.push(branch);
          } catch (e: any) {
            skippedBranches.push(`${branch} (${e.message})`);
          }
        }
      }

      // 3. Clean worktrees
      const deletedWorktrees: string[] = [];
      if (delete_worktrees) {
        try {
          const worktreeList = git(['worktree', 'list', '--porcelain'], room);
          const lines = worktreeList.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]?.startsWith('worktree ')) {
              const path = lines[i].replace('worktree ', '').replace(/^./, '').replace(/.$/, '');
              // Check if it's stale (path no longer exists)
              if (!existsSync(path) || !lstatSync(path).isDirectory()) {
                if (!dryRun) {
                  try {
                    git(['worktree', 'remove', path], room);
                    deletedWorktrees.push(path);
                  } catch { /* skip */ }
                } else {
                  deletedWorktrees.push(path);
                }
              }
            }
          }
        } catch { /* git worktree list may fail if none exist */ }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            mode: dryRun ? 'dry-run' : 'live',
            pruned_remote: results.includes('Pruned remote references'),
            gone_branches_found: goneBranches.length,
            deleted_branches: deletedBranches,
            skipped_branches: skippedBranches,
            deleted_worktrees: deletedWorktrees,
            errors: errors.length > 0 ? errors : undefined,
            summary: [
              results.join(', '),
              deletedBranches.length > 0 ? `${prefix} branches: ${deletedBranches.join(', ')}` : 'No gone branches found',
              deletedWorktrees.length > 0 ? `${prefix} worktrees: ${deletedWorktrees.join(', ')}` : '',
            ].filter(Boolean).join('\n'),
          }, null, 2),
        }],
      };
    }
  );
}

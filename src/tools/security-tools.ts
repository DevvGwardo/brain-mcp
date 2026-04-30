import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainDB } from '../db.js';

// ── Schema helpers ──
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

export interface SecurityToolsOptions {
  db: BrainDB;
  room: string;
  ensureSession: () => string;
  sessionName: string;
  sh: (value: string) => string;
}

// Security patterns to scan for, organized by severity and category
const SECURITY_PATTERNS = [
  // Critical — credentials and secrets
  { pattern: /(?<!['"`]\w*)[A-Za-z0-9+/]{20,}={0,2}(?!['"`]\w*)/, category: 'generic_secret', severity: 'critical', msg: 'Potential base64-encoded secret detected' },
  { pattern: /(?<![a-zA-Z0-9])(?:ghp_|gho_|github_pat_)[a-zA-Z0-9_]{36,}/, category: 'github_token', severity: 'critical', msg: 'GitHub personal access token hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:sk-[a-zA-Z0-9]{20,})(?![a-zA-Z0-9])/, category: 'openai_key', severity: 'critical', msg: 'OpenAI API key hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:xox[baprs]-[a-zA-Z0-9]{10,})(?![a-zA-Z0-9])/, category: 'slack_token', severity: 'critical', msg: 'Slack token hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:aws_access_key|aws_secret)[_a-zA-Z0-9]*\s*[=:]\s*['"]?[A-Z0-9]{20,}/i, category: 'aws_credential', severity: 'critical', msg: 'AWS credential hardcoded' },
  { pattern: /(?<![a-zA-Z0-9])(?:password|passwd|pwd|secret)\s*[=:]\s*['"][^'"]{8,}['"](?![a-zA-Z0-9]*['"])/i, category: 'hardcoded_password', severity: 'critical', msg: 'Hardcoded password detected' },
  // High — code injection and eval
  { pattern: /\beval\s*\(\s*(?:req|request|body|input|params|query|headers)/i, category: 'eval_injection', severity: 'high', msg: 'eval() with user-controlled input' },
  { pattern: /\bexec\s*\(\s*(?:req|request|body|input|params|query|headers)/i, category: 'exec_injection', severity: 'high', msg: 'exec() with user-controlled input' },
  { pattern: /\b__import__\s*\(\s*(?:req|request|body|input|params|query|headers)/i, category: 'import_injection', severity: 'high', msg: 'Dynamic import with user-controlled input' },
  { pattern: /\bpickle\.(load|loads)\s*\(/i, category: 'pickle_deserialize', severity: 'high', msg: 'pickle deserialization of untrusted data' },
  { pattern: /\.innerHTML\s*=/, category: 'xss_innerHTML', severity: 'high', msg: 'Direct innerHTML assignment — XSS risk' },
  { pattern: /document\.write\s*\(/, category: 'xss_docwrite', severity: 'high', msg: 'document.write() — XSS risk' },
  // Medium — injection and path traversal
  { pattern: /\brenderText\s*\([^)]*(?:req|request|body|input|params|query)/i, category: 'template_injection', severity: 'medium', msg: 'Template rendering with user input' },
  { pattern: /\bsystem\s*\([^)]*(?:req|request|body|input|params|query|cmd)/i, category: 'shell_injection', severity: 'medium', msg: 'shell command with user input' },
  { pattern: /(?<![a-zA-Z0-9])(?:cat|grep|sed|awk|find)\s+.*\$\{.*\}/, category: 'shell_injection', severity: 'medium', msg: 'Shell command with unquoted variable expansion' },
  // GitHub Actions specific
  { pattern: /\${{\s*github\.event\.issue\.title\s*}}/, category: 'gha_injection', severity: 'high', msg: 'GHA: Untrusted issue title in command — injection risk' },
  { pattern: /\${{\s*github\.event\.comment\.body\s*}}/, category: 'gha_injection', severity: 'high', msg: 'GHA: Untrusted comment body in command — injection risk' },
  { pattern: /\${{\s*github\.event\.pull_request\.title\s*}}/, category: 'gha_injection', severity: 'high', msg: 'GHA: Untrusted PR title in command — injection risk' },
  { pattern: /run:\s*\|?\s*\n.*\$\{\{/, category: 'gha_run_injection', severity: 'high', msg: 'GHA: User input in run: block — use env or GITHUB_ENV instead' },
  // SQL injection
  { pattern: /(?:mysql|postgres|sqlite|pg|createQuery|execute)\s*\([^)]*\+[^)]*(?:req|request|body|input|params|query)/i, category: 'sql_injection', severity: 'high', msg: 'SQL query with string concatenation — injection risk' },
  // Path traversal
  { pattern: /(?:readFile|readFileSync|open|readdir)\s*\([^)]*(?:req|request|body|input|params|query).*\+\s*['"]\.\.[/\\]/i, category: 'path_traversal', severity: 'high', msg: 'File operation with user input that includes path traversal (../)' },
  // Crypto
  { pattern: /crypto\.createCipher\s*\(/, category: 'weak_crypto', severity: 'medium', msg: 'createCipher is deprecated — use createCipheriv instead' },
  { pattern: /md5|sha1\s*(?!_sum)/i, category: 'weak_hash', severity: 'medium', msg: 'MD5/SHA1 used for security — consider SHA-256 or stronger' },
];

export function registerSecurityTools(
  server: { tool: (name: string, description: string, schema: any, handler: (params: any) => Promise<any>) => void },
  options: SecurityToolsOptions,
) {
  const { db, room, ensureSession, sessionName, sh } = options;

  server.tool(
    'security_scan',
    `Scan modified files for common security vulnerabilities. Checks for: hardcoded credentials,
API keys, GitHub tokens, eval/exec injection, pickle deserialization, XSS via innerHTML,
GitHub Actions injection vectors (\${github.event.* } without sanitization), SQL injection,
path traversal, weak crypto, and shell injection.

Results include severity, file path, line number, and a remediation suggestion.
Use the notify parameter to DM agents responsible for files with findings.`,
    {
      files: cArr(z.string()).optional().describe('Specific files to scan. Scans all staged/modified files if not provided.'),
      severity: z.enum(['critical', 'high', 'medium', 'all']).optional().describe('Minimum severity to report (default: high).'),
      notify: cBool().optional().describe('DM agents responsible for files with findings (default: true).'),
      dry_run: cBool().optional().describe('Show what would be scanned without scanning (default: false).'),
    },
    async ({ files, severity: minSeverity, notify: shouldNotify, dry_run: isDryRun }) => {
      const sid = ensureSession();

      // Get files to scan
      let targetFiles = files;
      if (!targetFiles) {
        try {
          // Get both staged and unstaged modified files
          const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf-8', cwd: room, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          const unstaged = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf-8', cwd: room, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf-8', cwd: room, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          const all = [staged, unstaged, untracked].flatMap(s => s.split('\n')).filter(f => f && !f.includes('node_modules') && !f.includes('.git'));
          targetFiles = [...new Set(all)];
        } catch { /* ignore */ }
      }

      if (!targetFiles || targetFiles.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ scanned: 0, findings: [], message: 'No files to scan.' }) }] };
      }

      const results: Array<{
        file: string;
        line: number;
        severity: string;
        category: string;
        message: string;
        line_content: string;
        agent?: string;
      }> = [];

      const SEVERITY_ORDER = ['critical', 'high', 'medium'];
      const minSev = minSeverity === 'all' ? 'medium' : (minSeverity || 'high');
      const minSevIdx = SEVERITY_ORDER.indexOf(minSev);

      for (const filePath of targetFiles) {
        if (isDryRun) {
          results.push({ file: filePath, line: 0, severity: 'info', category: 'scan', message: 'Would scan this file', line_content: '' });
          continue;
        }

        // Only scan source code and config files
        const SKIP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.lock'];
        if (SKIP_EXTENSIONS.some(ext => filePath.endsWith(ext))) continue;

        let content = '';
        try {
          content = readFileSync(join(room, filePath), 'utf-8');
        } catch { continue; }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const { pattern, category, severity, msg } of SECURITY_PATTERNS) {
            if (pattern.test(line)) {
              const sevIdx = SEVERITY_ORDER.indexOf(severity);
              if (sevIdx >= minSevIdx) {
                // Look up who claimed this file
                const claims = db.getClaims(room);
                const claim = claims.find(c => c.resource === filePath || filePath.startsWith(c.resource));
                results.push({
                  file: filePath,
                  line: i + 1,
                  severity,
                  category,
                  message: msg,
                  line_content: line.trim().substring(0, 200),
                  agent: claim?.owner_name,
                });
              }
            }
          }
        }
      }

      // Send DMs to responsible agents
      if (shouldNotify !== false && !isDryRun && results.length > 0) {
        const byAgent = new Map<string, typeof results>();
        for (const r of results) {
          if (r.agent) {
            const list = byAgent.get(r.agent) || [];
            list.push(r);
            byAgent.set(r.agent, list);
          }
        }
        for (const [agent, findings] of byAgent) {
          const summary = findings.map(f => `[${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.message}`).join('\n');
          db.sendDM(sid, sessionName, agent, `Security findings in files you modified:\n\n${summary}`);
        }
      }

      const criticalCount = results.filter(r => r.severity === 'critical').length;
      const highCount = results.filter(r => r.severity === 'high').length;
      const mediumCount = results.filter(r => r.severity === 'medium').length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            scanned: targetFiles.length,
            findings: results.filter(r => r.severity !== 'info'),
            breakdown: { critical: criticalCount, high: highCount, medium: mediumCount },
            agents_notified: shouldNotify !== false ? [...new Set(results.filter(r => r.agent).map(r => r.agent!))] : [],
            summary: results.length === 0
              ? `Clean: 0 security issues in ${targetFiles.length} files.`
              : `Found ${results.length} issues: ${criticalCount} critical, ${highCount} high, ${mediumCount} medium across ${targetFiles.length} files.`,
          }, null, 2),
        }],
      };
    }
  );
}

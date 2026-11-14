import { execFile } from 'child_process';
import { PrLink } from './model';

export function parsePrUrl(url: string): PrLink | undefined {
  const m = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url.trim());
  if (!m) {
    return undefined;
  }
  return { url: m[0], host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) };
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? `"${cmd}" was not found on your PATH.` : stderr.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function gitHead(root: string): Promise<string | undefined> {
  try {
    return (await run('git', ['rev-parse', 'HEAD'], root)).trim();
  } catch {
    return undefined;
  }
}

/** Path of a workspace file relative to the repository root, which is what GitHub expects. */
async function repoPath(root: string, file: string): Promise<string> {
  try {
    const prefix = (await run('git', ['rev-parse', '--show-prefix'], root)).trim();
    return prefix + file;
  } catch {
    return file;
  }
}

function api(pr: PrLink, endpoint: string, extra: string[]): string[] {
  const host = pr.host === 'github.com' ? [] : ['--hostname', pr.host];
  return ['api', ...host, `repos/${pr.owner}/${pr.repo}/pulls/${endpoint}`, ...extra];
}

export async function postComment(
  root: string,
  pr: PrLink,
  c: { file: string; startLine: number; endLine: number; body: string }
): Promise<{ id: number; url?: string }> {
  const sha = (await run('gh', ['pr', 'view', pr.url, '--json', 'headRefOid', '-q', '.headRefOid'], root)).trim();
  const args = api(pr, `${pr.number}/comments`, [
    '-f', `body=${c.body}`,
    '-f', `commit_id=${sha}`,
    '-f', `path=${await repoPath(root, c.file)}`,
    '-F', `line=${c.endLine}`,
    '-f', 'side=RIGHT'
  ]);
  if (c.startLine < c.endLine) {
    args.push('-F', `start_line=${c.startLine}`, '-f', 'start_side=RIGHT');
  }
  const out = JSON.parse(await run('gh', args, root));
  return { id: out.id, url: out.html_url };
}

export async function postReply(root: string, pr: PrLink, commentId: number, body: string): Promise<number> {
  const args = api(pr, `${pr.number}/comments/${commentId}/replies`, ['-f', `body=${body}`]);
  return JSON.parse(await run('gh', args, root)).id;
}

export interface RemoteComment {
  id: number;
  replyTo?: number;
  body: string;
  user: string;
  at: string;
}

export async function listComments(root: string, pr: PrLink): Promise<RemoteComment[]> {
  const jq = '.[] | {id, replyTo: .in_reply_to_id, body, user: .user.login, at: .created_at}';
  const out = await run('gh', api(pr, `${pr.number}/comments`, ['--paginate', '--jq', jq]), root);
  return out
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

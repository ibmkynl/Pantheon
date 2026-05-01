import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const exec = promisify(execFile);

function workingDir(projectId?: string, subDir?: string): string {
  const home = process.env['PANTHEON_HOME'] || path.join(os.homedir(), '.pantheon');
  const wsBase = process.env['PANTHEON_WORKSPACES'] ?? path.join(home, 'workspaces');
  if (projectId) {
    return subDir ? path.resolve(wsBase, projectId, 'files', subDir) : path.resolve(wsBase, projectId, 'files');
  }
  return subDir ? path.resolve(process.cwd(), subDir) : process.cwd();
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || 'git error');
  }
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function registerGitTools(server: McpServer): void {
  server.registerTool('git.status', {
    description: 'Show working tree status (porcelain format).',
    inputSchema: { projectId: z.string().optional(), dir: z.string().optional() },
  }, async ({ projectId, dir }) => {
    return ok(await git(['status', '--porcelain=v1', '--branch'], workingDir(projectId, dir)));
  });

  server.registerTool('git.diff', {
    description: 'Show unstaged or staged diffs. Pass `staged: true` for staged-only.',
    inputSchema: {
      projectId: z.string().optional(),
      dir:       z.string().optional(),
      staged:    z.boolean().optional(),
      paths:     z.array(z.string()).optional(),
    },
  }, async ({ projectId, dir, staged, paths }) => {
    const args = ['diff', '--no-color'];
    if (staged) args.push('--staged');
    if (paths?.length) args.push('--', ...paths);
    return ok(await git(args, workingDir(projectId, dir)));
  });

  server.registerTool('git.log', {
    description: 'Recent commit log (oneline format).',
    inputSchema: { projectId: z.string().optional(), dir: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ projectId, dir, limit = 20 }) => {
    return ok(await git(['log', '--oneline', `-n${limit}`], workingDir(projectId, dir)));
  });

  server.registerTool('git.branch', {
    description: 'List branches, or create a new branch with `name`.',
    inputSchema: {
      projectId: z.string().optional(),
      dir:       z.string().optional(),
      name:      z.string().optional(),
      from:      z.string().optional(),
    },
  }, async ({ projectId, dir, name, from }) => {
    const cwd = workingDir(projectId, dir);
    if (!name) return ok(await git(['branch', '-a', '--no-color'], cwd));
    const args = ['checkout', '-b', name];
    if (from) args.push(from);
    return ok(await git(args, cwd));
  });

  server.registerTool('git.checkout', {
    description: 'Switch branches or restore files.',
    inputSchema: { projectId: z.string().optional(), dir: z.string().optional(), ref: z.string().min(1) },
  }, async ({ projectId, dir, ref }) => {
    return ok(await git(['checkout', ref], workingDir(projectId, dir)));
  });

  server.registerTool('git.add', {
    description: 'Stage paths. Use `paths: ["."]` to stage everything tracked + untracked.',
    inputSchema: { projectId: z.string().optional(), dir: z.string().optional(), paths: z.array(z.string()).min(1) },
  }, async ({ projectId, dir, paths }) => {
    return ok(await git(['add', '--', ...paths], workingDir(projectId, dir)));
  });

  server.registerTool('git.commit', {
    description: 'Create a commit with the given message. Stages all tracked changes if `addAll: true`.',
    inputSchema: {
      projectId: z.string().optional(),
      dir:       z.string().optional(),
      message:   z.string().min(1),
      addAll:    z.boolean().optional(),
    },
  }, async ({ projectId, dir, message, addAll }) => {
    const cwd = workingDir(projectId, dir);
    if (addAll) await git(['add', '-A'], cwd);
    return ok(await git(['commit', '-m', message], cwd));
  });

  server.registerTool('git.push', {
    description: 'Push current branch to remote.',
    inputSchema: {
      projectId: z.string().optional(),
      dir:       z.string().optional(),
      remote:    z.string().optional(),
      branch:    z.string().optional(),
      setUpstream: z.boolean().optional(),
    },
  }, async ({ projectId, dir, remote = 'origin', branch, setUpstream }) => {
    const args = ['push'];
    if (setUpstream) args.push('-u');
    args.push(remote);
    if (branch) args.push(branch);
    return ok(await git(args, workingDir(projectId, dir)));
  });

  server.registerTool('git.pull', {
    description: 'Pull from remote (defaults to origin and current branch).',
    inputSchema: {
      projectId: z.string().optional(),
      dir:       z.string().optional(),
      remote:    z.string().optional(),
      branch:    z.string().optional(),
    },
  }, async ({ projectId, dir, remote = 'origin', branch }) => {
    const args = ['pull', remote];
    if (branch) args.push(branch);
    return ok(await git(args, workingDir(projectId, dir)));
  });

  server.registerTool('git.current_branch', {
    description: 'Return the currently checked-out branch name.',
    inputSchema: { projectId: z.string().optional(), dir: z.string().optional() },
  }, async ({ projectId, dir }) => {
    const text = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir(projectId, dir))).trim();
    return ok(text);
  });

  server.registerTool('git.show', {
    description: 'Show details of a specific commit (or HEAD).',
    inputSchema: { projectId: z.string().optional(), dir: z.string().optional(), ref: z.string().optional() },
  }, async ({ projectId, dir, ref = 'HEAD' }) => {
    return ok(await git(['show', '--no-color', ref], workingDir(projectId, dir)));
  });
}

import { spawn, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentRuntimeAdapter,
  AgentTaskInput,
  AgentTaskResult,
} from './types.js';

/**
 * Phase-2 adapter for Anthropic's Claude Code CLI (read-only / no tools).
 *
 * Runs `claude -p <prompt> --model <X> --output-format json --disallowedTools '*'`
 * as a child process and parses the structured result. Tools are blanket-disabled
 * so the adapter can't mutate the host repo or hit the network beyond the model
 * API call itself — keeps the §13 safety surface predictable for benchmarks.
 *
 * The §18 comparison this unlocks: pit `raw-anthropic` against `claude-code`
 * on the same model, see the runtime overhead (CLI startup, agent loop wrapper)
 * in coordinator/worker/merge latency numbers.
 *
 * Auth: passes through ANTHROPIC_API_KEY from the parent env. If the user has
 * a `claude login` session instead, that also works — the CLI handles its own
 * auth precedence.
 *
 * Failure-type discipline (per v0.2 spec addendum):
 *   cli_not_found     — `claude` binary not installed / not on PATH
 *   cli_crashed       — child exited non-zero without parseable JSON
 *   cli_parse         — output wasn't the expected JSON shape
 *   auth              — CLI reported missing/invalid credentials
 *   rate_limited      — CLI reported a 429 from upstream
 *   timeout           — we killed the process at input.timeoutMs
 *   runtime           — any other CLI-reported failure
 *
 * Override knobs (env vars):
 *   AFB_CLAUDE_CODE_BIN  — path to claude binary (default: "claude")
 *   AFB_CLAUDE_CODE_ARGS — extra args appended after the prompt (whitespace-split)
 */

type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ClaudeCodeAdapterOptions {
  spawnFn?: SpawnFn;
  cliPath?: string;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): AgentRuntimeAdapter {
  const spawnFn: SpawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
  const cli = opts.cliPath ?? process.env.AFB_CLAUDE_CODE_BIN ?? 'claude';
  const extraArgs = (process.env.AFB_CLAUDE_CODE_ARGS ?? '').split(/\s+/).filter(Boolean);

  return {
    name: 'claude-code',
    runtimeClass: 'agent_runtime',
    async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
      const start = Date.now();
      const args = [
        '-p',
        input.prompt,
        '--model',
        input.model,
        '--output-format',
        'json',
        '--disallowedTools',
        '*',
        ...extraArgs,
      ];

      try {
        const { stdout, stderr, exitCode, timedOut } = await runCli(
          spawnFn,
          cli,
          args,
          input.timeoutMs,
        );

        const latencyMs = Date.now() - start;

        if (timedOut) {
          return {
            taskId: input.taskId,
            ok: false,
            output: '',
            error: { type: 'timeout', message: `claude-code exceeded ${input.timeoutMs}ms` },
            latencyMs,
          };
        }

        // Try to parse JSON from stdout regardless of exit code — the CLI
        // sometimes emits the JSON result even when exit code is non-zero.
        const parsed = tryParseJson(stdout);

        if (exitCode !== 0 && !parsed) {
          const errMsg = (stderr || stdout || '').trim().slice(0, 500);
          const lower = errMsg.toLowerCase();
          // Heuristic mapping for common shapes.
          if (lower.includes('command not found') || lower.includes('enoent')) {
            return failure(input, latencyMs, 'cli_not_found', `binary "${cli}" not found`);
          }
          if (lower.includes('unauthor') || lower.includes('api key') || lower.includes('credential')) {
            return failure(input, latencyMs, 'auth', errMsg);
          }
          if (lower.includes('rate limit') || lower.includes('429')) {
            return failure(input, latencyMs, 'rate_limited', errMsg);
          }
          return failure(input, latencyMs, 'cli_crashed', errMsg || `exit ${exitCode}`);
        }

        if (!parsed) {
          return failure(
            input,
            latencyMs,
            'cli_parse',
            `expected JSON; got ${truncate(stdout, 200)}`,
          );
        }

        if (parsed.is_error) {
          // CLI reported a structured failure. Distinguish by subtype.
          const sub = parsed.subtype ?? 'runtime';
          const type =
            sub.includes('rate') ? 'rate_limited'
            : sub.includes('auth') ? 'auth'
            : 'runtime';
          return failure(input, latencyMs, type, `claude-code subtype=${sub}`);
        }

        const output = typeof parsed.result === 'string' ? parsed.result : '';
        return {
          taskId: input.taskId,
          ok: true,
          output,
          usage: parsed.usage
            ? {
                input_tokens: parsed.usage.input_tokens ?? 0,
                output_tokens: parsed.usage.output_tokens ?? 0,
              }
            : undefined,
          data: {
            session_id: parsed.session_id,
            cli_reported_duration_ms: parsed.duration_ms,
            cli_reported_cost_usd: parsed.total_cost_usd,
          },
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('ENOENT')) {
          return failure(input, latencyMs, 'cli_not_found', `binary "${cli}" not found`);
        }
        return failure(input, latencyMs, 'runtime', message);
      }
    },
  };
}

/** Spawn the CLI and collect stdout/stderr until exit or timeout. */
function runCli(
  spawnFn: SpawnFn,
  cli: string,
  args: readonly string[],
  timeoutMs: number | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(cli, args, { env: process.env });
    } catch (err) {
      reject(err);
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;

    if (timeoutMs && timeoutMs > 0) {
      killer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, timeoutMs);
    }

    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', (err) => {
      if (killer) clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      if (killer) clearTimeout(killer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? -1,
        timedOut,
      });
    });
  });
}

function tryParseJson(s: string): ClaudeJsonResult | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'object' && obj !== null) return obj as ClaudeJsonResult;
  } catch {
    // Some CLI versions emit multiple JSON lines; try the last non-empty line.
    const lines = trimmed.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (typeof obj === 'object' && obj !== null) return obj as ClaudeJsonResult;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function failure(
  input: AgentTaskInput,
  latencyMs: number,
  type: string,
  message: string,
): AgentTaskResult {
  return {
    taskId: input.taskId,
    ok: false,
    output: '',
    error: { type, message: truncate(message, 500) },
    latencyMs,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export const claudeCodeAdapter = createClaudeCodeAdapter();

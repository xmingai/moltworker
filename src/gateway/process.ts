import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { ensureRcloneConfig } from './r2';
import { waitForProcess } from './utils';

/**
 * Pre-seed openclaw.json config into the container.
 * This runs BEFORE start-openclaw.sh so the script finds an existing config
 * and skips its broken `openclaw onboard` command.
 */
async function preseedOpenClawConfig(sandbox: Sandbox, env: MoltbotEnv): Promise<void> {
  console.log('[Config] Pre-seeding openclaw.json...');

  // Build provider config based on available keys
  let providerConfig: Record<string, unknown> = {};
  let defaultModel = '';

  if (env.GEMINI_API_KEY) {
    providerConfig = {
      'google-gemini': {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        api: 'openai-completions',
        apiKey: env.GEMINI_API_KEY,
        models: [
          { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1048576, maxTokens: 8192 },
          { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 65536 },
        ],
      },
    };
    defaultModel = 'google-gemini/gemini-2.0-flash';
  } else if (env.ANTHROPIC_API_KEY) {
    providerConfig = {
      anthropic: {
        api: 'anthropic-messages',
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        models: [{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet', contextWindow: 200000, maxTokens: 8192 }],
      },
    };
    defaultModel = 'anthropic/claude-sonnet-4-20250514';
  } else if (env.OPENAI_API_KEY) {
    providerConfig = {
      openai: {
        api: 'openai-completions',
        apiKey: env.OPENAI_API_KEY,
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 4096 }],
      },
    };
    defaultModel = 'openai/gpt-4o';
  } else {
    console.log('[Config] No provider key found, skipping pre-seed');
    return;
  }

  const gatewayToken = env.MOLTBOT_GATEWAY_TOKEN || '';
  const config = {
    gateway: {
      port: MOLTBOT_PORT,
      mode: 'local',
      bind: 'lan',
      trustedProxies: ['10.1.0.0'],
      auth: gatewayToken ? { token: gatewayToken } : {},
      controlUi: { allowInsecureAuth: env.DEV_MODE === 'true' },
    },
    models: { providers: providerConfig },
    agents: { defaults: { model: defaultModel ? { primary: defaultModel } : {} } },
    channels: {},
  };

  const configJson = JSON.stringify(config);

  // Write config to container via node -e (heredoc hangs in sandbox.startProcess)
  const escaped = configJson.replace(/'/g, "'\\''");
  const writeCmd = `mkdir -p /root/.openclaw && node -e 'require("fs").writeFileSync("/root/.openclaw/openclaw.json", JSON.stringify(JSON.parse(process.argv[1]), null, 2))' '${escaped}'`;
  try {
    const proc = await sandbox.startProcess(writeCmd);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stderr) {
      console.error('[Config] Write stderr:', logs.stderr);
    }
    console.log('[Config] Pre-seeded config with provider:', Object.keys(providerConfig)[0]);
  } catch (e) {
    console.error('[Config] Failed to pre-seed config:', e);
    // Don't throw — let start-openclaw.sh try its own config generation
  }
}

/**
 * Find an existing OpenClaw gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Match gateway process (openclaw gateway or legacy clawdbot gateway)
      // Don't match CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        // Legacy: match old startup script during transition
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the OpenClaw gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Configure rclone for R2 persistence (non-blocking if not configured).
  // The startup script uses rclone to restore data from R2 on boot.
  await ensureRcloneConfig(sandbox, env);

  // Check if gateway is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log(
      'Found existing gateway process:',
      existingProcess.id,
      'status:',
      existingProcess.status,
    );

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Gateway is reachable');
      return existingProcess;
      // eslint-disable-next-line no-unused-vars
    } catch (_e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new OpenClaw gateway
  console.log('Starting new OpenClaw gateway...');
  const envVars = buildEnvVars(env);

  // Pre-seed openclaw.json before start-openclaw.sh runs.
  // This bypasses the shell script's `openclaw onboard` command (which has
  // version-specific CLI flags) by writing a valid config directly.
  // The old script will find the existing config and skip onboard.
  await preseedOpenClawConfig(sandbox, env);

  const command = '/usr/local/bin/start-openclaw.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] OpenClaw gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`, {
        cause: e,
      });
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');

  return process;
}

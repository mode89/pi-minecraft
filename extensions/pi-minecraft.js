const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseArgs } = require("node:util");

const DEFAULT_HTTP = "localhost:3000";
const MCBOT_ARG_OPTIONS = {
  server: { type: "string" },
  user: { type: "string" },
  http: { type: "string" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" },
};

module.exports = function minecraftExtension(pi) {
  const paths = getPackagePaths();
  const extensionState = { chatListener: null };

  pi.on("session_shutdown", async (_event, ctx) => {
    stopCurrentChatListener(extensionState);
    if (ctx && ctx.cwd) await stopManagedBot(ctx.cwd, paths.botScript);
  });

  pi.on("before_agent_start", (event, ctx) => (
    injectMinecraftPrompt(event, ctx, paths)
  ));

  pi.registerCommand("minecraft:start", {
    description: "Start the Mineflayer mcbot background process",
    handler: (args, ctx) => startMinecraft(
      pi,
      ctx,
      args,
      extensionState,
      paths,
    ),
  });

  pi.registerCommand("minecraft:stop", {
    description: "Stop the background mcbot process",
    handler: (_args, ctx) => stopMinecraft(ctx, extensionState, paths),
  });

  pi.registerCommand("minecraft:status", {
    description: "Show background mcbot process status",
    handler: (_args, ctx) => showMinecraftStatus(ctx, extensionState, paths),
  });
};

function getPackagePaths() {
  const packageRoot = path.resolve(__dirname, "..");
  return {
    botScript: path.join(packageRoot, "mcbot.js"),
    systemPromptPath: path.join(packageRoot, "system.md"),
  };
}

async function injectMinecraftPrompt(event, ctx, paths) {
  if (!ctx || !ctx.cwd) return undefined;

  const state = await readManagedState(ctx.cwd, paths.botScript);
  if (!state) return undefined;

  const systemPrompt = await fs.promises.readFile(
    paths.systemPromptPath,
    "utf8",
  );
  return {
    systemPrompt: [
      event.systemPrompt,
      systemPrompt,
      formatRuntimeContext(ctx.cwd, state),
    ].join("\n\n"),
  };
}

async function startMinecraft(pi, ctx, args, extensionState, paths) {
  const existing = await readManagedState(ctx.cwd, paths.botScript);
  if (existing) {
    startChatListener(pi, ctx, extensionState, existing.http);
    notify(
      ctx,
      `mcbot already running: pid ${existing.pid}; listening for chat`,
      "info",
    );
    return;
  }

  let parsedArgs;
  try {
    parsedArgs = parseMcbotArgs(args || "");
  } catch (error) {
    notify(ctx, `invalid mcbot args: ${error.message}`, "error");
    return;
  }

  const { argv: botArgs, http } = parsedArgs;
  const { child, logPath } = spawnManagedBot(ctx.cwd, paths.botScript, botArgs);
  const state = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    command: [process.execPath, paths.botScript, ...botArgs],
    http,
    logPath,
  };
  writeState(ctx.cwd, state);

  const probe = await waitForEvalReady(
    state.http,
    child.pid,
    paths.botScript,
    10000,
  );

  if (probe.status === "ready") {
    startChatListener(pi, ctx, extensionState, state.http);
    notify(
      ctx,
      `started mcbot: pid ${child.pid}; /eval is ready; `
        + `listening for Minecraft chat; bot instructions will be `
        + `injected into future prompts; log ${relative(ctx.cwd, logPath)}`,
      "success",
    );
    return;
  }

  if (probe.status === "exited") {
    clearState(ctx.cwd);
    notify(
      ctx,
      `mcbot exited before /eval became ready; `
        + `log ${relative(ctx.cwd, logPath)}`,
      "error",
    );
    return;
  }

  notify(
    ctx,
    `started mcbot: pid ${child.pid}, but /eval did not become `
      + `ready within 10 seconds; Minecraft bot instructions will be `
      + `injected into future prompts; log ${relative(ctx.cwd, logPath)}`,
    "warning",
  );
}

async function stopMinecraft(ctx, extensionState, paths) {
  const state = await readManagedState(ctx.cwd, paths.botScript);
  if (!state) {
    clearState(ctx.cwd);
    notify(ctx, "mcbot is not running", "info");
    return;
  }

  stopCurrentChatListener(extensionState);
  await stopManagedBot(ctx.cwd, paths.botScript);
  notify(
    ctx,
    `stopped mcbot: pid ${state.pid}; Minecraft bot instructions disabled`,
    "success",
  );
}

async function showMinecraftStatus(ctx, extensionState, paths) {
  const state = await readStateIfExists(ctx.cwd);
  if (!state) {
    notify(ctx, "mcbot status: not running", "info");
    return;
  }

  if (!isManagedProcess(state.pid, paths.botScript)) {
    clearState(ctx.cwd);
    notify(
      ctx,
      `mcbot status: stale pid ${state.pid}; cleaned state`,
      "warning",
    );
    return;
  }

  const reachable = await isHttpReachable(state.http);
  const listening = extensionState.chatListener
    && extensionState.chatListener.hostPort === state.http;
  notify(
    ctx,
    [
      "mcbot status: running",
      `pid: ${state.pid}`,
      `started: ${state.startedAt}`,
      `http: http://${state.http}/eval `
        + `(${reachable ? "reachable" : "not reachable yet"})`,
      `chat listener: ${listening ? "connected" : "not connected"}`,
      `log: ${relative(ctx.cwd, state.logPath)}`,
    ].join("\n"),
    reachable ? "success" : "warning",
  );
}

function spawnManagedBot(cwd, botScript, botArgs) {
  const runtimeDir = ensureRuntimeDir(cwd);
  const logPath = path.join(runtimeDir, "mcbot.log");
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");

  try {
    const child = spawn(process.execPath, [botScript, ...botArgs], {
      cwd,
      detached: true,
      stdio: ["ignore", out, err],
      env: process.env,
    });
    child.unref();
    return { child, logPath };
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

function formatRuntimeContext(cwd, state) {
  return [
    "# Active Minecraft Bot Runtime",
    "",
    `- HTTP endpoint: http://${state.http}/eval`,
    `- PID: ${state.pid}`,
    `- Log: ${relative(cwd, state.logPath)}`,
  ].join("\n");
}

async function readManagedState(cwd, botScript) {
  const state = await readStateIfExists(cwd);
  if (!state) return null;
  if (isManagedProcess(state.pid, botScript)) return state;
  clearState(cwd);
  return null;
}

async function stopManagedBot(cwd, botScript) {
  const state = await readManagedState(cwd, botScript);
  if (!state) return;

  signalProcess(state.pid, "SIGTERM");
  const stopped = await waitForExit(state.pid, 3000);
  if (!stopped && isManagedProcess(state.pid, botScript)) {
    signalProcess(state.pid, "SIGKILL");
    await waitForExit(state.pid, 1000);
  }
  clearState(cwd);
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!error || error.code !== "ESRCH") throw error;
  }
}

function startChatListener(pi, ctx, extensionState, hostPort) {
  extensionState.chatListener = ensureChatListener(
    pi,
    ctx,
    extensionState.chatListener,
    hostPort || DEFAULT_HTTP,
  );
}

function stopCurrentChatListener(extensionState) {
  stopChatListener(extensionState.chatListener);
  extensionState.chatListener = null;
}

function ensureChatListener(pi, ctx, current, hostPort) {
  if (current && current.hostPort === hostPort) return current;
  stopChatListener(current);

  const controller = new AbortController();
  const listener = { hostPort, controller };
  runChatListenerWithReconnect(pi, ctx, hostPort, controller.signal);
  return listener;
}

async function runChatListenerWithReconnect(pi, ctx, hostPort, signal) {
  // Node's fetch (undici) drops idle response bodies after ~5 minutes with
  // `TypeError: terminated`. mcbot now sends a heartbeat, but also reconnect
  // defensively on any non-abort failure so a blip doesn't silently stop chat.
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await runChatListener(pi, ctx, hostPort, signal);
      attempt = 0;
    } catch (error) {
      if (signal.aborted) return;
      const delay = Math.min(30000, 500 * 2 ** attempt++);
      notify(
        ctx,
        `Minecraft chat listener disconnected (${error.message}); `
          + `reconnecting in ${Math.round(delay / 1000)}s`,
        "warning",
      );
      await sleep(delay, signal);
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

function stopChatListener(listener) {
  if (listener && listener.controller) listener.controller.abort();
}

async function runChatListener(pi, ctx, hostPort, signal) {
  const response = await fetch(`http://${hostPort}/listen`, { signal });
  if (!response.ok) {
    throw new Error(`GET /listen failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("GET /listen returned no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) throw new Error("GET /listen ended");
    buffered += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) sendChatTurn(pi, ctx, line);
    }
  }
}

function sendChatTurn(pi, ctx, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    notify(ctx, `Ignoring malformed Minecraft chat event: ${line}`, "warning");
    return;
  }
  if (event.type !== "chat" || typeof event.message !== "string") return;

  const username = event.username || "unknown";
  const prompt = `Minecraft chat message from ${username}: ${event.message}`;
  try {
    if (ctx && typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(prompt);
    }
  } catch (error) {
    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch (fallbackError) {
      notify(
        ctx,
        `Failed to queue Minecraft chat message: ${fallbackError.message}`,
        "error",
      );
    }
  }
}

function getRuntimeDir(cwd) {
  return path.join(cwd, ".pi", "minecraft");
}

function ensureRuntimeDir(cwd) {
  const dir = getRuntimeDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStatePath(cwd) {
  return path.join(getRuntimeDir(cwd), "mcbot.json");
}

function getLogPath(cwd) {
  return path.join(getRuntimeDir(cwd), "mcbot.log");
}

async function readStateIfExists(cwd) {
  try {
    return JSON.parse(await fs.promises.readFile(getStatePath(cwd), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function writeState(cwd, state) {
  ensureRuntimeDir(cwd);
  fs.writeFileSync(getStatePath(cwd), JSON.stringify(state, null, 2) + "\n");
}

function clearState(cwd) {
  try { fs.unlinkSync(getStatePath(cwd)); } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function isManagedProcess(pid, botScript) {
  if (!isPidRunning(pid)) return false;
  // On Linux, avoid killing an unrelated process if a stale PID was reused.
  // On other platforms or if /proc is inaccessible, fall back to kill(pid, 0).
  try {
    const cmdline = fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0/g, " ");
    return cmdline.includes(botScript)
      || cmdline.includes(path.basename(botScript));
  } catch {
    return true;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidRunning(pid);
}

async function waitForEvalReady(hostPort, pid, botScript, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isManagedProcess(pid, botScript)) return { status: "exited" };
    if (await probeEval(hostPort)) return { status: "ready" };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!isManagedProcess(pid, botScript)) return { status: "exited" };
  return { status: "timeout" };
}

async function isHttpReachable(hostPort) {
  return probeEval(hostPort);
}

async function probeEval(hostPort) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`http://${hostPort}/eval`, {
      method: "POST",
      body: 'print("ok")',
      signal: controller.signal,
    });
    return res.ok && (await res.text()) === "ok\n";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMcbotArgs(input) {
  const trimmed = Array.isArray(input) ? null : input.trim();
  const argv = Array.isArray(input)
    ? input
    : (trimmed ? trimmed.split(/\s+/) : []);
  const { values } = parseArgs({
    args: argv,
    options: MCBOT_ARG_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  return { argv, http: values.http || DEFAULT_HTTP };
}

function relative(cwd, target) {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith("..") ? rel : target;
}

function notify(ctx, message, level) {
  if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
    ctx.ui.notify(message, level);
  } else {
    console.log(message);
  }
}

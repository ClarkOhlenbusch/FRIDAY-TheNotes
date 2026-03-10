#!/usr/bin/env node
/**
 * Auto-detect GPU and run Tauri with appropriate features
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSidecar } = require('./prepare-tauri-sidecar');
const DEV_PORT = 3118;
const ORT_WINDOWS_VERSION = '1.22.0';
const ORT_WINDOWS_NUGET_PACKAGE = 'microsoft.ml.onnxruntime';

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const parsed = {};
  const content = fs.readFileSync(filePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim();
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadLocalEnv() {
  const cwd = process.cwd();
  return {
    ...parseEnvFile(path.join(cwd, '.env')),
    ...parseEnvFile(path.join(cwd, '.env.local')),
  };
}

function prependWindowsToolPaths(env) {
  if (os.platform() !== 'win32') {
    return env;
  }

  const candidateDirs = [
    path.join(env.USERPROFILE || process.env.USERPROFILE || '', '.cargo', 'bin'),
    path.join(env.ProgramFiles || process.env.ProgramFiles || 'C:\\Program Files', 'CMake', 'bin'),
    path.join(
      env['ProgramFiles(x86)'] || process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'CMake',
      'bin'
    )
  ].filter(Boolean);

  const currentPath = env.PATH || process.env.PATH || '';
  const existingEntries = new Set(currentPath.split(path.delimiter).filter(Boolean));
  const dirsToPrepend = candidateDirs.filter((dir) => fs.existsSync(dir) && !existingEntries.has(dir));

  if (dirsToPrepend.length > 0) {
    env.PATH = `${dirsToPrepend.join(path.delimiter)}${path.delimiter}${currentPath}`;
    process.env.PATH = env.PATH;
  }

  return env;
}

function getWindowsPowerShellPath(env) {
  return path.join(
    env.SystemRoot || process.env.SystemRoot || 'C:\\WINDOWS',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function resolveCargoTargetDir(frontendDir, targetDir) {
  if (!targetDir) {
    return null;
  }

  return path.isAbsolute(targetDir) ? targetDir : path.resolve(frontendDir, targetDir);
}

function getWindowsDevCargoTargetDir(frontendDir, feature) {
  const targetFlavor = (feature && feature !== 'none' ? feature : 'cpu')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return path.resolve(frontendDir, '..', `target-tauri-dev-${targetFlavor}`);
}

function removeBlankEnvValues(env, keys) {
  const removed = [];

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }

    const value = env[key];
    if (typeof value === 'string' && value.trim() === '') {
      delete env[key];
      delete process.env[key];
      removed.push(key);
    }
  }

  return removed;
}

function getWhisperTargetBuildDirs(frontendDir, env) {
  const targetDir = resolveCargoTargetDir(frontendDir, env.CARGO_TARGET_DIR || process.env.CARGO_TARGET_DIR);

  if (targetDir) {
    return [path.join(targetDir, 'debug', 'build')];
  }

  return [path.join(frontendDir, '..', 'target', 'debug', 'build')];
}

function windowsWhisperBindingsAreOpaque(frontendDir, env) {
  if (os.platform() !== 'win32') {
    return false;
  }

  let sawBindings = false;
  let sawHealthyBindings = false;

  for (const targetBuildDir of getWhisperTargetBuildDirs(frontendDir, env)) {
    if (!fs.existsSync(targetBuildDir)) {
      continue;
    }

    const buildDirs = fs
      .readdirSync(targetBuildDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('whisper-rs-sys-'));

    for (const buildDir of buildDirs) {
      const bindingsPath = path.join(targetBuildDir, buildDir.name, 'out', 'bindings.rs');
      if (!fs.existsSync(bindingsPath)) {
        continue;
      }

      sawBindings = true;
      const bindings = fs.readFileSync(bindingsPath, 'utf8');
      if (
        bindings.includes('pub struct whisper_full_params {') &&
        bindings.includes('pub _address: u8,')
      ) {
        continue;
      }

      sawHealthyBindings = true;
    }
  }

  return sawBindings && !sawHealthyBindings;
}

function clearBrokenWindowsWhisperArtifacts(frontendDir, env) {
  if (os.platform() !== 'win32') {
    return;
  }

  if (!windowsWhisperBindingsAreOpaque(frontendDir, env)) {
    return;
  }

  console.log('Detected stale broken whisper-rs Windows bindings; cleaning whisper artifacts once.');
  execSync('cargo clean -p whisper-rs-sys -p whisper-rs', {
    cwd: path.join(frontendDir, 'src-tauri'),
    stdio: 'inherit',
    env,
  });
}

function escapePowerShellString(value) {
  return value.replace(/'/g, "''");
}

function findWindowsRepoNativeBuildProcesses(frontendDir, env) {
  if (os.platform() !== 'win32') {
    return [];
  }

  const workspaceRoot = path.resolve(frontendDir, '..');
  const powershell = getWindowsPowerShellPath(env);
  const script = `
$workspace = '${escapePowerShellString(workspaceRoot)}'
$names = @('MSBuild.exe', 'cargo.exe', 'cmake.exe', 'cl.exe')
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -and
  ($names -contains $_.Name) -and
  $_.CommandLine -and
  $_.CommandLine -like "*$workspace*"
} | Select-Object @{
  Name = 'pid'; Expression = { [int]$_.ProcessId }
}, @{
  Name = 'name'; Expression = { $_.Name }
}, @{
  Name = 'commandLine'; Expression = { $_.CommandLine }
}
if ($procs) {
  $procs | ConvertTo-Json -Compress
}
`;

  try {
    const output = execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        env,
      }
    ).trim();

    if (!output) {
      return [];
    }

    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function stopWindowsStaleNativeBuildProcesses(frontendDir, env) {
  if (os.platform() !== 'win32') {
    return;
  }

  const processes = findWindowsRepoNativeBuildProcesses(frontendDir, env);
  if (processes.length === 0) {
    return;
  }

  const uniqueProcesses = Array.from(
    new Map(processes.map((proc) => [proc.pid, proc])).values()
  );
  const names = Array.from(new Set(uniqueProcesses.map((proc) => proc.name))).join(', ');
  console.log(
    `Found ${uniqueProcesses.length} stale repo-scoped native build process(es); stopping ${names} before launch.`
  );

  for (const proc of uniqueProcesses) {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env,
      });
    } catch {
      // Ignore races where the process exits between discovery and taskkill.
    }
  }
}

function getWindowsOrtRuntimeDir(frontendDir) {
  return path.join(
    frontendDir,
    '.tauri-native',
    'onnxruntime',
    'win-x64',
    ORT_WINDOWS_VERSION
  );
}

function ensureWindowsOrtRuntime(frontendDir, env) {
  if (os.platform() !== 'win32') {
    return null;
  }

  const runtimeDir = getWindowsOrtRuntimeDir(frontendDir);
  const dllPath = path.join(runtimeDir, 'onnxruntime.dll');
  if (fs.existsSync(dllPath)) {
    return dllPath;
  }

  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });

  const tempRoot = fs.mkdtempSync(path.join(path.dirname(runtimeDir), 'ort-download-'));
  const packageUrl =
    `https://api.nuget.org/v3-flatcontainer/${ORT_WINDOWS_NUGET_PACKAGE}/${ORT_WINDOWS_VERSION}/` +
    `${ORT_WINDOWS_NUGET_PACKAGE}.${ORT_WINDOWS_VERSION}.nupkg`;
  const packagePath = path.join(
    tempRoot,
    `${ORT_WINDOWS_NUGET_PACKAGE}.${ORT_WINDOWS_VERSION}.zip`
  );
  const extractDir = path.join(tempRoot, 'extract');
  const powershell = getWindowsPowerShellPath(env);

  console.log(
    `Preparing official ONNX Runtime Windows runtime ${ORT_WINDOWS_VERSION} for dynamic loading...`
  );

  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$packageUrl = '${escapePowerShellString(packageUrl)}'
$packagePath = '${escapePowerShellString(packagePath)}'
$extractDir = '${escapePowerShellString(extractDir)}'
$runtimeDir = '${escapePowerShellString(runtimeDir)}'

New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $packageUrl -OutFile $packagePath
Expand-Archive -Path $packagePath -DestinationPath $extractDir -Force

$nativeDir = Join-Path $extractDir 'runtimes\\win-x64\\native'
$dllPath = Join-Path $nativeDir 'onnxruntime.dll'
if (-not (Test-Path $dllPath)) {
  throw "ONNX Runtime package did not contain runtimes\\\\win-x64\\\\native\\\\onnxruntime.dll"
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item -Path (Join-Path $nativeDir '*') -Destination $runtimeDir -Recurse -Force
`;

  try {
    execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        stdio: 'inherit',
        env,
      }
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (!fs.existsSync(dllPath)) {
    throw new Error(
      `Failed to provision ONNX Runtime runtime. Expected DLL at ${dllPath}`
    );
  }

  return dllPath;
}

function resolveWindowsOrtDylibPath(frontendDir, env) {
  if (os.platform() !== 'win32') {
    return null;
  }

  const configuredPath = env.ORT_DYLIB_PATH || process.env.ORT_DYLIB_PATH;
  if (configuredPath) {
    if (fs.existsSync(configuredPath)) {
      return configuredPath;
    }

    console.log(
      `Configured ORT_DYLIB_PATH does not exist (${configuredPath}); provisioning a local runtime instead.`
    );
  }

  return ensureWindowsOrtRuntime(frontendDir, env);
}

function getListeningPids(port) {
  if (os.platform() === 'win32') {
    const powershell = getWindowsPowerShellPath(process.env);
    const script = `
$connections = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($connections) {
  $connections
}
`;

    try {
      const output = execFileSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }
      );

      return output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  try {
    const output = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getProcessCommand(pid) {
  if (os.platform() === 'win32') {
    const powershell = getWindowsPowerShellPath(process.env);
    const script = `
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue
if ($proc -and $proc.CommandLine) {
  $proc.CommandLine
}
`;

    try {
      return execFileSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }
      ).trim();
    } catch {
      return '';
    }
  }

  try {
    return execSync(`ps -o command= -p ${pid}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isNextDevProcess(commandLine, port) {
  if (!commandLine) {
    return false;
  }

  return (
    commandLine.includes('next dev') ||
    (commandLine.includes('next/dist/bin/next') &&
      (commandLine.includes(`-p ${port}`) || commandLine.includes(` ${port}`)))
  );
}

function sleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy wait is acceptable here because this is a short-lived dev launcher.
  }
}

function waitForPortToFree(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getListeningPids(port).length === 0) {
      return true;
    }
    sleep(100);
  }

  return getListeningPids(port).length === 0;
}

function ensureFrontendPortAvailable(port) {
  const pids = getListeningPids(port);
  if (pids.length === 0) {
    return;
  }

  const owners = pids.map((pid) => ({
    pid,
    command: getProcessCommand(pid),
  }));
  const nextOwners = owners.filter(({ command }) => isNextDevProcess(command, port));

  if (nextOwners.length === owners.length) {
    console.log(`🧹 Found existing Next dev server on port ${port}; stopping it before launch.`);
    for (const { pid } of nextOwners) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch {
        // Ignore races where the process exits before we signal it.
      }
    }

    if (!waitForPortToFree(port)) {
      console.log(`⚠️  Next dev server on port ${port} did not exit after SIGTERM; forcing it down.`);
      for (const { pid } of nextOwners) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          // Ignore races where the process exits before we signal it.
        }
      }
    }

    if (waitForPortToFree(port)) {
      return;
    }
  }

  const ownerDetails = owners
    .map(({ pid, command }) => `PID ${pid}: ${command || 'unknown process'}`)
    .join('\n');
  console.error(`❌ Port ${port} is already in use.\n${ownerDetails}`);
  console.error('Close the existing process or change the frontend dev port before running tauri:dev.');
  process.exit(1);
}

const localEnv = loadLocalEnv();
const env = prependWindowsToolPaths({
  ...localEnv,
  ...process.env,
});
const frontendDir = process.cwd();

// Get the command (dev or build)
const command = process.argv[2];
if (!command || !['dev', 'build'].includes(command)) {
  console.error('Usage: node tauri-auto.js [dev|build]');
  process.exit(1);
}

const requestedFeature = process.argv[3];
const platform = os.platform();

// Detect GPU feature
let feature = '';

// CLI override takes precedence, then environment variable, then auto-detection.
if (requestedFeature) {
  feature = requestedFeature;
  console.log(`🔧 Using forced GPU feature from CLI: ${feature}`);
} else if (env.TAURI_GPU_FEATURE) {
  feature = env.TAURI_GPU_FEATURE;
  console.log(`🔧 Using forced GPU feature from environment: ${feature}`);
} else if (platform === 'win32' && command === 'dev') {
  feature = 'none';
  console.log('Windows dev mode defaults to CPU-only to keep first-run builds responsive.');
  console.log('Use `pnpm run tauri:dev:cuda` or `pnpm run tauri:dev:vulkan` to opt into GPU builds.');
} else {
  try {
    const result = execSync('node scripts/auto-detect-gpu.js', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    });
    feature = result.trim();
  } catch (err) {
    // If detection fails, continue with no features
  }
}

console.log(''); // Empty line for spacing

// Platform-specific environment variables

if (command === 'dev') {
  ensureFrontendPortAvailable(DEV_PORT);
}

if (platform === 'win32') {
  const clearedBlankEnvKeys = removeBlankEnvValues(env, [
    'ORT_LIB_LOCATION',
    'ORT_LIB_PROFILE',
    'ORT_SKIP_DOWNLOAD',
    'ORT_DYLIB_PATH',
    'CARGO_NET_OFFLINE',
  ]);
  if (clearedBlankEnvKeys.length > 0) {
    console.log(
      `Cleared blank native build env var(s): ${clearedBlankEnvKeys.join(', ')}.`
    );
  }

  if (!env.CMAKE_BUILD_PARALLEL_LEVEL) {
    env.CMAKE_BUILD_PARALLEL_LEVEL = '4';
  }
  if (!env.CARGO_BUILD_JOBS) {
    env.CARGO_BUILD_JOBS = '4';
  }
  if (!env.WHISPER_DONT_GENERATE_BINDINGS) {
    env.WHISPER_DONT_GENERATE_BINDINGS = '1';
  }

  process.env.CMAKE_BUILD_PARALLEL_LEVEL = env.CMAKE_BUILD_PARALLEL_LEVEL;
  process.env.CARGO_BUILD_JOBS = env.CARGO_BUILD_JOBS;
  process.env.WHISPER_DONT_GENERATE_BINDINGS = env.WHISPER_DONT_GENERATE_BINDINGS;

  const ortDylibPath = resolveWindowsOrtDylibPath(frontendDir, env);
  env.ORT_DYLIB_PATH = ortDylibPath;
  process.env.ORT_DYLIB_PATH = env.ORT_DYLIB_PATH;

  if ((env.ORT_SKIP_DOWNLOAD || '').toLowerCase() !== 'true') {
    console.log(
      'Windows uses the official dynamic ONNX Runtime runtime; skipping ort-sys binary download.'
    );
  }
  env.ORT_SKIP_DOWNLOAD = 'true';
  process.env.ORT_SKIP_DOWNLOAD = env.ORT_SKIP_DOWNLOAD;
  console.log(`Windows ONNX Runtime DLL: ${env.ORT_DYLIB_PATH}`);

  if (command === 'dev') {
    const targetDir = getWindowsDevCargoTargetDir(frontendDir, feature);
    env.CARGO_TARGET_DIR = targetDir;
    process.env.CARGO_TARGET_DIR = targetDir;

    if ((env.CARGO_NET_OFFLINE || '').toLowerCase() === 'true') {
      console.log('Windows dev mode overrides CARGO_NET_OFFLINE to allow native dependency downloads.');
    }
    env.CARGO_NET_OFFLINE = 'false';
    process.env.CARGO_NET_OFFLINE = env.CARGO_NET_OFFLINE;

    console.log(`Windows dev Cargo target dir: ${env.CARGO_TARGET_DIR}`);
    console.log(`Cargo offline mode for this run: ${env.CARGO_NET_OFFLINE}`);

    stopWindowsStaleNativeBuildProcesses(frontendDir, env);
  }

  clearBrokenWindowsWhisperArtifacts(frontendDir, env);
}

if (platform === 'linux' && feature === 'cuda') {
  console.log('🐧 Linux/CUDA detected: Setting CMAKE flags for NVIDIA GPU');
  env.CMAKE_CUDA_ARCHITECTURES = '75';
  env.CMAKE_CUDA_STANDARD = '17';
  env.CMAKE_POSITION_INDEPENDENT_CODE = 'ON';
}

try {
  ensureSidecar(command, feature || 'none');
  console.log('');
} catch (err) {
  console.error(`❌ Failed to prepare llama-helper sidecar: ${err.message || err}`);
  process.exit(1);
}

// Build the tauri command
let tauriCmd = `tauri ${command}`;
if (feature && feature !== 'none') {
  tauriCmd += ` -- --features ${feature}`;
  console.log(`🚀 Running: tauri ${command} with features: ${feature}`);
} else {
  console.log(`🚀 Running: tauri ${command} (CPU-only mode)`);
}

if (platform === 'win32' && command === 'dev' && (env.TAURI_NO_WATCH || '').toLowerCase() === 'true') {
  tauriCmd += ' --no-watch';
  console.log('Windows dev mode is running with TAURI_NO_WATCH=true; the Tauri Rust watcher is disabled for this run.');
}
console.log('');

// Execute the command
try {
  execSync(tauriCmd, { stdio: 'inherit', env });
} catch (err) {
  process.exit(err.status || 1);
}

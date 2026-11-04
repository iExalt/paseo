import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import {
  resolvePaseoHome,
  startDaemonInstance,
  DaemonInstanceError,
  stopDaemonInstance,
  readDaemonInstance,
  isSameDaemonInstance,
  readLocalCredentialForTarget,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  type AppUpdateCheckIntent,
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import {
  createNixUpdaterCommandRunner,
  NIX_UPDATE_COMMANDS,
  parseConfirmedDaemonInstance,
  restartIntoActiveNixRelease,
  type NixUpdateCommand,
  type NixUpdateResult,
} from "../features/nix-managed-updater.js";
import {
  resolveDesktopInstallation,
  type DesktopInstallation,
} from "../features/nix-managed-install.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
} from "../integrations/cli-install/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import { createDaemonUpgrader, type ActiveRelease, type IdleStopResult } from "./daemon-upgrade.js";
import type { NodeEntrypointInvocation } from "./node-entrypoint-launcher.js";
import { daemonBundleRebase, rebaseDaemonLaunch, shouldSyncInstalledCopy } from "./store-bundle.js";
import {
  ExternalCliCommandError,
  runExternalCliJsonCommand,
  runExternalCliTextCommand,
} from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { describeSandbox } from "../diagnostics/sandbox.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { getDesktopUpdaterDiagnostics } from "../diagnostics/updater.js";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "../integrations/legacy-skill-selection.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
let ownedLaunch: { home: string; instance: DaemonInstance } | null = null;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "app_update",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  ownedByDesktop: boolean;
  startedAt: string | null;
  error: string | null;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseReleaseChannel(
  args: Record<string, unknown> | undefined,
): AppReleaseChannel | undefined {
  if (args?.releaseChannel === "beta") {
    return "beta";
  }
  if (args?.releaseChannel === "stable") {
    return "stable";
  }
  return undefined;
}

function parseAppUpdateCheckIntent(
  args: Record<string, unknown> | undefined,
): AppUpdateCheckIntent {
  return args?.intent === "manual" ? "manual" : "automatic";
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome(process.env);
}

function logFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  if (!ownedLaunch) return false;
  try {
    const lock = JSON.parse(readFileSync(path.join(ownedLaunch.home, "paseo.pid"), "utf8"));
    return isSameDaemonInstance(lock, ownedLaunch.instance) && isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await stopDesktopDaemon(reason);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  let status: DesktopDaemonState = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error: null,
  };
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();

  try {
    // The app polls this while no local daemon runs. Answer that case in-process,
    // since launching the CLI once per poll keeps spawning processes while idle.
    if (!(await readDaemonInstance(home))) {
      return statusFromDaemonProbe({ localDaemon: "stopped" }, home);
    }

    const payload = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      home,
      "--json",
    ])) as Record<string, unknown>;
    return statusFromDaemonProbe(payload, home);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus failed", { error: errorMessage });
    return {
      serverId: "",
      status: "errored",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      ownedByDesktop: false,
      startedAt: null,
      error: errorMessage,
    };
  }
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  return daemonUpgrader.ensure();
}

// Asks the running daemon to stop only if no agent has work; throws when the outcome is unknown.
async function stopDaemonIfIdle(): Promise<IdleStopResult> {
  try {
    const result = (await runExternalCliJsonCommand([
      "daemon",
      "stop",
      "--home",
      getPaseoHome(),
      "--if-idle",
      "--json",
    ])) as { action?: unknown };
    return result.action === "declined" ? "declined" : "stopped";
  } catch (error) {
    if (error instanceof ExternalCliCommandError && error.code === "IDLE_SHUTDOWN_UNSUPPORTED")
      return "unsupported";
    throw error;
  }
}

const daemonUpgrader = createDaemonUpgrader({
  appVersion: () => resolveDesktopAppVersion(),
  platform: process.platform,
  readStatus: () => resolveDesktopDaemonStatus(),
  stopIfIdle: stopDaemonIfIdle,
  launch: launchDaemon,
  managementEnabled: async () => (await getDesktopSettingsStore().get()).daemon.manageBuiltInDaemon,
  isActiveRelease: () => isActiveRelease(),
  onUpgraded: () => syncInstalledAppCopy(),
  log: logDesktopDaemonLifecycle,
});

// Set by registerDaemonManager for Nix installs: a stale app copy must not downgrade a newer
// daemon, so only the active release replaces a daemon of another version.
let isActiveRelease: () => Promise<ActiveRelease> = async () => "active";
let syncInstalledAppCopy: () => void = () => {};

/** Moves a daemon launch onto the store bundle on Nix-managed macOS; see store-bundle.ts. */
function launchFromStoreBundle(invocation: NodeEntrypointInvocation): NodeEntrypointInvocation {
  const rebase = daemonBundleRebase({
    platform: process.platform,
    isPackaged: app.isPackaged,
    installation: resolveDesktopInstallation(process.resourcesPath),
    resourcesPath: process.resourcesPath,
    exists: existsSync,
  });
  if (!rebase) return invocation;
  const moved = rebaseDaemonLaunch(invocation, rebase);
  if (!existsSync(moved.command)) {
    logDesktopDaemonLifecycle("store bundle helper missing; launching from the app bundle", {
      command: moved.command,
    });
    return invocation;
  }
  logDesktopDaemonLifecycle("launching daemon from the store bundle", { command: moved.command });
  return moved;
}

async function launchDaemon(): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();
  const invocation = launchFromStoreBundle(
    createNodeEntrypointInvocation({
      entrypoint: resolveDaemonRunnerEntrypoint(),
      argvMode: "node-script",
      args: [],
      baseEnv: process.env,
    }),
  );
  try {
    await startDaemonInstance({
      home,
      timeoutMs: 30_000,
      ...invocation,
      env: { ...invocation.env, PASEO_CLI: getBundledCliShimPath() },
      mode: "managed",
      desktopManaged: true,
      onAcquired: (instance) => {
        ownedLaunch = { home, instance };
      },
    });
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) throw error;
  }
  return resolveDesktopDaemonStatus();
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  confirmedInstance?: { pid: number; startedAt: string },
): Promise<DesktopDaemonStatus> {
  daemonUpgrader.cancel();
  const home = getPaseoHome();
  const instance = await readDaemonInstance(home);
  const owned = Boolean(
    instance &&
    ownedLaunch &&
    ownedLaunch.home === home &&
    isSameDaemonInstance(instance, ownedLaunch.instance),
  );
  const explicit =
    reason === "manual_ipc" &&
    confirmedInstance &&
    instance &&
    instance.pid === confirmedInstance.pid &&
    instance.startedAt === confirmedInstance.startedAt;
  if (confirmedInstance && !explicit)
    throw new Error(
      "Daemon changed since confirmation; inspect its current home and PID before stopping it.",
    );
  if (!instance || (!owned && !explicit)) return resolveDesktopDaemonStatus();
  const keepTerminals = keepsTerminalsOnStop(reason, process.platform);
  logDesktopDaemonLifecycle("stopping captured supervisor", {
    reason,
    pid: instance.pid,
    owned,
    keepTerminals,
  });
  await stopCapturedDaemon({ home, instance, reason, keepTerminals });
  if (owned) ownedLaunch = null;
  return resolveDesktopDaemonStatus();
}

export interface StopCapturedDaemonInput {
  home: string;
  instance: DaemonInstance;
  reason: DesktopDaemonStopReason;
  keepTerminals: boolean;
  stopInstance?: typeof stopDaemonInstance;
  runCliJson?: typeof runExternalCliJsonCommand;
  log?: typeof logDesktopDaemonLifecycle;
}

/** Stops the supervisor desktop captured, keeping its terminals when asked and supported. */
export async function stopCapturedDaemon(input: StopCapturedDaemonInput): Promise<void> {
  const stopInstance = input.stopInstance ?? stopDaemonInstance;
  const runCliJson = input.runCliJson ?? runExternalCliJsonCommand;
  const logLifecycle = input.log ?? logDesktopDaemonLifecycle;
  const stop = (keep: boolean) =>
    stopInstance(input.home, {
      instance: input.instance,
      timeoutMs: 15_000,
      keepTerminals: keep,
      requestShutdown: async (ready) => {
        await runCliJson([
          "daemon",
          "stop",
          "--host",
          ready.listen,
          ...(keep ? ["--keep-terminals"] : []),
          "--json",
        ]);
      },
    });
  try {
    await stop(input.keepTerminals);
  } catch (error) {
    // The CLI refuses a keep stop before sending anything when the daemon predates the feature;
    // that daemon closes terminals on every stop, as every upgrade did before.
    if (
      !input.keepTerminals ||
      !(error instanceof ExternalCliCommandError) ||
      error.code !== "TERMINALS_KEEP_UNSUPPORTED"
    ) {
      throw error;
    }
    const version = typeof error.error?.version === "string" ? error.error.version : "unknown";
    logLifecycle(`daemon v${version} cannot keep terminals; stopping it and closing them`, {
      reason: input.reason,
      pid: input.instance.pid,
    });
    await stop(false);
  }
}

/**
 * Whether a desktop stop keeps the daemon's terminals running for the daemon that replaces it.
 * Only when one comes straight back (an app update), and never on Windows: a surviving terminal
 * worker runs Paseo.exe and would lock the install folder the update replaces. Quit, Settings,
 * host removal and manual stops close terminals. An idle-only upgrade stop always keeps them.
 */
export function keepsTerminalsOnStop(
  reason: DesktopDaemonStopReason,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") return false;
  return reason === "app_update";
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  await runExternalCliJsonCommand(["daemon", "restart", "--home", getPaseoHome(), "--json"]);
  return resolveDesktopDaemonStatus();
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status", "--home", getPaseoHome()]);
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

async function resolveRequestedReleaseChannel(
  args: Record<string, unknown> | undefined,
): Promise<AppReleaseChannel> {
  return parseReleaseChannel(args) ?? (await getDesktopSettingsStore().get()).releaseChannel;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(
  input: {
    installation?: DesktopInstallation;
    runNixUpdate?: (command: NixUpdateCommand) => Promise<NixUpdateResult>;
    quitForRelaunch?: () => void;
  } = {},
): Record<string, DesktopCommandHandler> {
  const installation = input.installation ?? resolveDesktopInstallation(process.resourcesPath);
  const runNixUpdate =
    input.runNixUpdate ??
    createNixUpdaterCommandRunner({ installation, runningVersion: app.getVersion() });
  const handlers: Record<string, DesktopCommandHandler> = {
    ...createDesktopSettingsCommandHandlers({ settingsStore: getDesktopSettingsStore() }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    desktop_local_credential: async (args) => {
      const instance = await readDaemonInstance(getPaseoHome());
      if (!instance?.desktopManaged || typeof args?.listen !== "string") return null;
      return readLocalCredentialForTarget(getPaseoHome(), args.listen);
    },
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) =>
      stopDesktopDaemon(
        parseDesktopDaemonStopReason(args),
        parseConfirmedDaemonInstance(args) ?? undefined,
      ),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_sandbox_diagnostics: () =>
      describeSandbox({
        disabled: app.commandLine.hasSwitch("no-sandbox"),
        launcherReason: process.env.PASEO_DESKTOP_SANDBOX_REASON,
      }),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_update_diagnostics: () => getDesktopUpdaterDiagnostics(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => await openLocalTransportSession(args),
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    check_app_update: async (args) => {
      if (installation.mode !== "electron") {
        throw new Error("Electron updates are disabled for Nix-managed desktop installations.");
      }
      const currentVersion = resolveDesktopAppVersion();
      return checkForAppUpdate({
        currentVersion,
        releaseChannel: await resolveRequestedReleaseChannel(args),
        intent: parseAppUpdateCheckIntent(args),
      });
    },
    install_app_update: async (args) => {
      if (installation.mode !== "electron") {
        throw new Error("Electron updates are disabled for Nix-managed desktop installations.");
      }
      const currentVersion = resolveDesktopAppVersion();
      return downloadAndInstallUpdate(
        { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
        async () => {
          await stopDesktopDaemon("app_update");
        },
      );
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    read_legacy_skill_selection: () => readLegacySkillSelection(),
    delete_legacy_skill_selection: () => deleteLegacySkillSelection(),
  };
  if (installation.mode !== "electron") {
    for (const command of NIX_UPDATE_COMMANDS) {
      handlers[`nix_update_${command}`] = () => runNixUpdate(command);
    }
    handlers.nix_update_restart = () =>
      restartIntoActiveNixRelease({
        runNixUpdate,
        relaunch: (target) => {
          if (target.kind === "exec") app.relaunch({ execPath: target.execPath });
          else spawn(target.command, target.args, { detached: true, stdio: "ignore" }).unref();
          // Quit after the IPC reply is sent; the relaunch waits for this process to exit. The
          // quit leaves the daemon running whatever keepRunningAfterQuit says.
          setImmediate(() => (input.quitForRelaunch ?? (() => app.quit()))());
        },
        cliPath: installation.mode === "nix" ? installation.cliPath : "",
        pid: process.pid,
        platform: process.platform,
      });
  }
  return handlers;
}

export function registerDaemonManager(
  installation?: DesktopInstallation,
  options: { quitForRelaunch?: () => void } = {},
): void {
  const handlers = createDaemonCommandHandlers({
    installation,
    quitForRelaunch: options.quitForRelaunch,
  });
  // A retry must not start a daemon while the app quits.
  app.on("before-quit", () => daemonUpgrader.close());
  if (installation?.mode === "nix") configureNixDaemonUpgrade(installation);

  ipcMain.handle(
    "paseo:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}

function configureNixDaemonUpgrade(
  installation: Extract<DesktopInstallation, { mode: "nix" }>,
): void {
  const runNixUpdate = createNixUpdaterCommandRunner({
    installation,
    runningVersion: app.getVersion(),
  });
  // Cached for the session: activating a newer release changes nothing until the restart,
  // because the app's and the daemon's versions stay the same until then.
  let active: Promise<ActiveRelease> | null = null;
  isActiveRelease = () => {
    active ??= runNixUpdate("status")
      .then((status): ActiveRelease =>
        status.active?.outputPath === installation.outputPath ? "active" : "inactive",
      )
      .catch((error) => {
        active = null;
        logDesktopDaemonLifecycle("could not read the active Nix release", {
          error: String(error),
        });
        return "unknown" as const;
      });
    return active;
  };
  if (process.platform !== "darwin") return;
  // A deferred copy leaves the app running from its store bundle and /Applications on an older
  // release. Retry the copy once nothing runs from it; the updater skips a current or busy copy.
  syncInstalledAppCopy = () => {
    if (!shouldSyncInstalledCopy(process.resourcesPath)) return;
    logDesktopDaemonLifecycle("syncing /Applications/Paseo.app with the running release");
    const sync = spawn(installation.cliPath, ["install-app"], { detached: true, stdio: "ignore" });
    sync.on("exit", (code) => logDesktopDaemonLifecycle("app copy sync finished", { code }));
    sync.on("error", (error) =>
      logDesktopDaemonLifecycle("app copy sync failed", { error: String(error) }),
    );
    sync.unref();
  };
  syncInstalledAppCopy();
}

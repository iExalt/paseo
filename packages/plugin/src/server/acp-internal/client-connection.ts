import {
  client,
  methods,
  type ClientConnection,
  type ClientNotificationParamsByMethod,
  type ClientRequestParamsByMethod,
  type ClientRequestResponsesByMethod,
  type MaybePromise,
  type AgentRequestParamsByMethod,
  type CancelNotification,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";

const agentMethods = methods.agent;
const clientMethods = methods.client;

type ClientRequest<Method extends keyof ClientRequestParamsByMethod> = (
  params: ClientRequestParamsByMethod[Method],
) => MaybePromise<ClientRequestResponsesByMethod[Method]>;

type SessionUpdate = ClientNotificationParamsByMethod[typeof clientMethods.session.update];

export interface AcpClientHandlers {
  requestPermission: ClientRequest<typeof clientMethods.session.requestPermission>;
  sessionUpdate(params: SessionUpdate): MaybePromise<void>;
  writeTextFile?: ClientRequest<typeof clientMethods.fs.writeTextFile>;
  readTextFile?: ClientRequest<typeof clientMethods.fs.readTextFile>;
  createTerminal?: ClientRequest<typeof clientMethods.terminal.create>;
  terminalOutput?: ClientRequest<typeof clientMethods.terminal.output>;
  releaseTerminal?(
    params: ClientRequestParamsByMethod[typeof clientMethods.terminal.release],
  ): MaybePromise<void>;
  waitForTerminalExit?: ClientRequest<typeof clientMethods.terminal.waitForExit>;
  killTerminal?: ClientRequest<typeof clientMethods.terminal.kill>;
  extNotification?(method: string, params: Record<string, unknown>): MaybePromise<void>;
}

// Both Paseo ACP adapters own a long-lived transport. Keep the IPC request mapping
// here so the daemon and plugin use identical v1 methods and permission semantics.
export class AcpClientConnection {
  private readonly connection: ClientConnection;

  constructor(handlers: AcpClientHandlers, stream: Stream) {
    const app = client()
      .onRequest(clientMethods.session.requestPermission, ({ params }) =>
        handlers.requestPermission(params),
      )
      .onNotification(clientMethods.session.update, ({ params }) => handlers.sessionUpdate(params));
    const {
      writeTextFile,
      readTextFile,
      createTerminal,
      terminalOutput,
      releaseTerminal,
      waitForTerminalExit,
      killTerminal,
    } = handlers;
    if (writeTextFile)
      app.onRequest(clientMethods.fs.writeTextFile, ({ params }) =>
        writeTextFile.call(handlers, params),
      );
    if (readTextFile)
      app.onRequest(clientMethods.fs.readTextFile, ({ params }) =>
        readTextFile.call(handlers, params),
      );
    if (createTerminal)
      app.onRequest(clientMethods.terminal.create, ({ params }) =>
        createTerminal.call(handlers, params),
      );
    if (terminalOutput)
      app.onRequest(clientMethods.terminal.output, ({ params }) =>
        terminalOutput.call(handlers, params),
      );
    if (releaseTerminal)
      app.onRequest(clientMethods.terminal.release, async ({ params }) => {
        await releaseTerminal.call(handlers, params);
        return {};
      });
    if (waitForTerminalExit)
      app.onRequest(clientMethods.terminal.waitForExit, ({ params }) =>
        waitForTerminalExit.call(handlers, params),
      );
    if (killTerminal)
      app.onRequest(clientMethods.terminal.kill, ({ params }) =>
        killTerminal.call(handlers, params),
      );
    if (handlers.extNotification)
      app.onNotification("*", ({ method, params }) => {
        if (typeof params === "object" && params !== null && !Array.isArray(params)) {
          return handlers.extNotification?.(method, params as Record<string, unknown>);
        }
      });
    this.connection = app.connect(stream);
  }

  get signal() {
    return this.connection.signal;
  }

  get closed() {
    return this.connection.closed;
  }

  initialize(params: AgentRequestParamsByMethod[typeof agentMethods.initialize]) {
    return this.connection.agent.request(agentMethods.initialize, params);
  }

  newSession(params: AgentRequestParamsByMethod[typeof agentMethods.session.new]) {
    return this.connection.agent.request(agentMethods.session.new, params);
  }

  loadSession(params: AgentRequestParamsByMethod[typeof agentMethods.session.load]) {
    return this.connection.agent.request(agentMethods.session.load, params);
  }

  resumeSession(params: AgentRequestParamsByMethod[typeof agentMethods.session.resume]) {
    return this.connection.agent.request(agentMethods.session.resume, params);
  }

  listSessions(params: AgentRequestParamsByMethod[typeof agentMethods.session.list]) {
    return this.connection.agent.request(agentMethods.session.list, params);
  }

  closeSession(params: AgentRequestParamsByMethod[typeof agentMethods.session.close]) {
    return this.connection.agent.request(agentMethods.session.close, params);
  }

  setSessionConfigOption(
    params: AgentRequestParamsByMethod[typeof agentMethods.session.setConfigOption],
  ) {
    return this.connection.agent.request(agentMethods.session.setConfigOption, params);
  }

  setSessionMode(params: AgentRequestParamsByMethod[typeof agentMethods.session.setMode]) {
    return this.connection.agent.request(agentMethods.session.setMode, params);
  }

  prompt(params: AgentRequestParamsByMethod[typeof agentMethods.session.prompt]) {
    return this.connection.agent.request(agentMethods.session.prompt, params);
  }

  cancel(params: CancelNotification) {
    return this.connection.agent.notify(agentMethods.session.cancel, params);
  }

  request(method: string, params?: Record<string, unknown>) {
    return this.connection.agent.request(method, params);
  }
}

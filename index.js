// Printer Warden — host half.
// Discovers the LAN printer, keeps the Windows queue pointed at it, and repairs the port after an IP change.
import { scanLan, resolveStableHost, modelsMatch } from './lib/scan.js';
import {
  queryPrinters,
  pickQueue,
  portOf,
  portNameFor,
  queueOnline,
  setDefaultPrinter,
  applyBinding,
} from './lib/printers.js';

export const name = 'printer-warden';

const STACK_TTL_MS = 15000;

export function apply(ctx, config = {}) {
  const settings = {
    queueName: typeof config.queueName === 'string' && config.queueName ? config.queueName : null,
    autoDefault: config.autoDefault !== false,
  };

  const discovered = {
    candidates: [],
    scannedAt: null,
    scanning: false,
    binding: false,
    lastError: null,
    notes: [],
    toolReady: false,
    toolError: null,
  };

  let stackCache = null;
  let stackAt = 0;

  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[printer-warden] ${message}`);
    } catch {
      /* logging is best effort */
    }
  };

  async function readStack(force = false) {
    const now = Date.now();
    if (!force && stackCache && now - stackAt < STACK_TTL_MS) return stackCache;
    const data = await queryPrinters();
    stackCache = data;
    stackAt = now;
    return data;
  }

  async function computeState() {
    let stack;
    try {
      stack = await readStack();
    } catch (error) {
      return {
        ok: false,
        error: 'print-stack-unreadable',
        message: String(error?.message ?? error),
        queue: null,
        candidates: discovered.candidates,
        scanning: discovered.scanning,
        binding: discovered.binding,
      };
    }
    const queue = pickQueue(stack.printers, settings.queueName);
    const port = portOf(stack.ports, queue?.port);
    const online = queue ? await queueOnline(port) : null;
    const queueModel = `${queue?.name ?? ''} ${queue?.driver ?? ''}`;
    const portIsIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(port?.host ?? ''));
    // Only call it "moved" when the queue really cannot connect and a matching printer answers elsewhere.
    const movedTo =
      online === false
        ? discovered.candidates.find(
            (c) => c.kind === 'printer' && modelsMatch(queueModel, `${c.model ?? ''} ${c.name ?? ''}`) && (!portIsIp || c.ip !== port?.host),
          ) ?? null
        : null;
    return {
      ok: true,
      spooler: stack.spooler,
      user: stack.user,
      queue: queue
        ? {
            name: queue.name,
            driver: queue.driver,
            port: queue.port,
            portHost: port?.host ?? null,
            portNumber: port?.number ?? null,
            online,
            isDefault: queue.name === stack.defaultPrinter,
          }
        : null,
      defaultPrinter: stack.defaultPrinter,
      legacyDefaultMode: stack.legacyDefaultMode,
      printers: stack.printers,
      candidates: discovered.candidates,
      scannedAt: discovered.scannedAt,
      scanning: discovered.scanning,
      binding: discovered.binding,
      lastError: discovered.lastError,
      notes: discovered.notes,
      toolReady: discovered.toolReady,
      toolError: discovered.toolError,
      movedTo: movedTo ? { ip: movedTo.ip, model: movedTo.model, name: movedTo.name } : null,
    };
  }

  async function scan() {
    if (discovered.scanning) return { ok: true, already: true };
    discovered.scanning = true;
    discovered.lastError = null;
    try {
      const result = await scanLan();
      discovered.candidates = result.candidates ?? [];
      discovered.scannedAt = result.scannedAt ?? new Date().toISOString();
      discovered.notes = result.notes ?? [];
      return { ok: true, count: discovered.candidates.length };
    } catch (error) {
      discovered.lastError = String(error?.message ?? error);
      return { ok: false, error: 'scan-failed', message: discovered.lastError };
    } finally {
      discovered.scanning = false;
    }
  }

  async function bind(ip) {
    if (discovered.binding) return { ok: false, error: 'busy', message: '正在绑定，请稍候' };
    discovered.binding = true;
    discovered.lastError = null;
    try {
      if (discovered.candidates.length === 0) await scan();
      const candidate =
        discovered.candidates.find((c) => c.ip === ip) ??
        discovered.candidates.find((c) => c.kind === 'printer') ??
        null;
      if (!candidate) return { ok: false, error: 'printer-not-found', message: '没有发现可绑定的打印机，请先扫描局域网' };

      const stack = await readStack(true);
      const queue = pickQueue(stack.printers, settings.queueName);
      if (!queue) return { ok: false, error: 'no-local-queue', message: '本机没有可用的打印队列' };

      const stable = await resolveStableHost(candidate);
      const portName = portNameFor(candidate.model ?? queue.name, queue.name);
      const result = await applyBinding({
        queueName: queue.name,
        driverName: queue.driver,
        portName,
        hostAddress: stable.host,
        portNumber: 9100,
        makeDefault: settings.autoDefault,
      });
      stackCache = null;
      if (!result.ok) {
        discovered.lastError = result.error ?? 'apply-failed';
        return {
          ok: false,
          error: result.error?.startsWith('elevation-cancelled') ? 'elevation-cancelled' : 'apply-failed',
          message:
            result.error?.startsWith('elevation-cancelled')
              ? '需要管理员授权：请在 UAC 窗口点「是」后重试'
              : result.error,
          steps: result.steps ?? [],
        };
      }
      return {
        ok: true,
        steps: result.steps ?? [],
        usedHost: stable.host,
        hostKind: stable.kind,
        queue: queue.name,
        port: portName,
      };
    } catch (error) {
      discovered.lastError = String(error?.message ?? error);
      return { ok: false, error: 'bind-failed', message: discovered.lastError };
    } finally {
      discovered.binding = false;
    }
  }

  async function makeDefault() {
    try {
      const stack = await readStack(true);
      const queue = pickQueue(stack.printers, settings.queueName);
      if (!queue) return { ok: false, error: 'no-local-queue', message: '本机没有可用的打印队列' };
      await setDefaultPrinter(queue.name);
      stackCache = null;
      return { ok: true, queue: queue.name };
    } catch (error) {
      return { ok: false, error: 'default-failed', message: String(error?.message ?? error) };
    }
  }

  // Web API used by the sidebar panel. Loopback only; same-origin POST.
  ctx.inject(['webServer'], (webCtx) => {
    const allowedOrigin = () => {
      try {
        return webCtx.webServer.getOrigin();
      } catch {
        return null;
      }
    };

    const handler = async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      try {
        const remote = req.socket?.remoteAddress ?? '';
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
          send(403, { ok: false, error: 'loopback-only' });
          return;
        }
        if (req.method !== 'POST') {
          send(405, { ok: false, error: 'POST only' });
          return;
        }
        const origin = req.headers.origin;
        const own = allowedOrigin();
        if (origin && own && origin !== own) {
          send(403, { ok: false, error: 'origin-rejected' });
          return;
        }
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 64 * 1024) throw new Error('body too large');
        }
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          send(400, { ok: false, error: 'bad-json' });
          return;
        }
        switch (body.action) {
          case 'state':
            send(200, await computeState());
            return;
          case 'scan': {
            const result = await scan();
            if (!result.ok) {
              send(200, result);
              return;
            }
            send(200, await computeState());
            return;
          }
          case 'bind': {
            const result = await bind(body.ip);
            send(200, { ...result, state: await computeState() });
            return;
          }
          case 'default': {
            const result = await makeDefault();
            send(200, { ...result, state: await computeState() });
            return;
          }
          default:
            send(400, { ok: false, error: 'unknown-action' });
        }
      } catch (error) {
        log('warn', `api failure: ${error?.message ?? error}`);
        send(500, { ok: false, error: 'internal', message: String(error?.message ?? error) });
      }
    };

    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: '/printer-warden/api', handler }), 'printer-warden: api route');
    log('info', 'api route registered at /printer-warden/api');
  });

  // Agent tool: the same operations from chat.
  const bindTool = (tools) => {
    if (!tools) {
      discovered.toolError = 'tools service unavailable';
      return;
    }
    try {
      tools.register({
        name: 'printer_warden',
        description:
          'Manage the LAN shared printer on this Windows machine: status of the local print queue and its TCP/IP port, ' +
          'scan the LAN for printers (PJL/IPP/mDNS), bind a discovered printer to the local queue and set it as the default ' +
          '(one UAC consent), and repair the port after the printer changed IP.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'scan', 'bind', 'default'],
              description:
                'status: current queue/port/online. scan: discover LAN printers. bind: point the queue at a printer and set default. default: set the queue as the Windows default.',
            },
            ip: {
              type: 'string',
              description: 'Printer IPv4 address to bind; omit to use the best discovered printer.',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {},
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          switch (args.action) {
            case 'status': {
              const state = await computeState();
              return {
                queue: state.queue,
                defaultPrinter: state.defaultPrinter,
                candidates: (state.candidates ?? []).map((c) => ({ ip: c.ip, model: c.model, name: c.name, kind: c.kind })),
                scannedAt: state.scannedAt,
                movedTo: state.movedTo,
              };
            }
            case 'scan': {
              const result = await scan();
              const state = await computeState();
              return { ...result, candidates: (state.candidates ?? []).map((c) => ({ ip: c.ip, model: c.model, mac: c.mac, ports: c.ports, kind: c.kind })) };
            }
            case 'bind':
              return bind(args.ip);
            case 'default':
              return makeDefault();
            default:
              throw new Error(`unknown action: ${String(args.action)}`);
          }
        },
      });
      discovered.toolReady = true;
      log('info', 'agent tool printer_warden registered');
    } catch (error) {
      discovered.toolError = String(error?.message ?? error);
      log('warn', `agent tool registration failed: ${discovered.toolError}`);
    }
  };
  ctx.inject(['tools'], (toolCtx) => {
    bindTool(toolCtx.tools);
  });
}

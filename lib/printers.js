// Local print-stack reads and default-printer control. WMI-free so it works under restricted tokens.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTcp } from './scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'scripts');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function run(file, args, timeout = 25000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Read printers, ports and the default queue through scripts/query.ps1. */
export async function queryPrinters() {
  const dir = await mkdtemp(path.join(tmpdir(), 'printer-warden-'));
  const out = path.join(dir, 'printers.json');
  try {
    await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'query.ps1'), '-Out', out]);
    const raw = await readFile(out, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const VIRTUAL = /(microsoft print to pdf|microsoft xps|onenote|fax|send to)/i;

/** Choose the queue this plugin manages: explicit name, else the first real local queue. */
export function pickQueue(printers, preferred) {
  const list = Array.isArray(printers) ? printers : [];
  if (preferred) {
    const exact = list.find((p) => p.name === preferred);
    if (exact) return exact;
  }
  return list.find((p) => !VIRTUAL.test(p.name) && p.port && p.port !== 'nul:' && !p.port.endsWith(':')) ?? list[0] ?? null;
}

export function portOf(ports, portName) {
  if (!portName) return null;
  return (ports ?? []).find((p) => p.name === portName) ?? null;
}

export function isIpLiteral(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(value ?? ''));
}

/** A short ASCII port name derived from the model, stable across IP changes. */
export function portNameFor(model, fallback) {
  const slug = String(model ?? fallback ?? 'printer')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `PW_${slug || 'printer'}`;
}

/** Reachability of the queue's current port endpoint. */
export async function queueOnline(portInfo, timeoutMs = 650) {
  if (!portInfo || !portInfo.host) return null;
  const port = Number(portInfo.number) > 0 ? Number(portInfo.number) : 9100;
  return probeTcp(portInfo.host, port, timeoutMs);
}

export async function setDefaultPrinter(name) {
  if (!name) throw new Error('打印机名称为空');
  await run('rundll32.exe', ['printui.dll,PrintUIEntry', '/y', '/n', name], 15000);
  await run('reg.exe', [
    'add',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows',
    '/v',
    'LegacyDefaultPrinterMode',
    '/t',
    'REG_DWORD',
    '/d',
    '1',
    '/f',
  ], 10000).catch(() => {});
  return true;
}

/** Write the apply config and run scripts/apply.ps1; escalate through UAC only if the system refuses. */
export async function applyBinding(config) {
  const dir = await mkdtemp(path.join(tmpdir(), 'printer-warden-apply-'));
  const cfgPath = path.join(dir, 'apply.json');
  const resPath = path.join(dir, 'result.json');
  const readResult = async () => {
    try {
      return JSON.parse((await readFile(resPath, 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  };
  try {
    await writeFile(cfgPath, JSON.stringify(config), 'utf8');

    // Most machines let the signed-in user manage print queues; try without a UAC prompt first.
    let directFailure = null;
    try {
      await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'apply.ps1'), '-ConfigPath', cfgPath, '-ResultPath', resPath], 120000);
    } catch (error) {
      directFailure = error;
    }
    let result = await readResult();
    if (result?.ok) return result;

    const refused = !result || /access is denied|access denied|拒绝访问|权限|denied|0x80070005/i.test(String(result.error ?? ''));
    if (!refused) {
      return result ?? { ok: false, steps: [], error: `apply-failed: ${directFailure?.stderr || directFailure?.message || 'no result'}` };
    }

    // The system refused: ask for administrator consent once.
    let failure = null;
    try {
      await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'launch-apply.ps1'), '-ConfigPath', cfgPath, '-ResultPath', resPath], 180000);
    } catch (error) {
      failure = error;
    }
    result = await readResult();
    if (!result) {
      return {
        ok: false,
        steps: [],
        error: failure?.message?.includes('canceled')
          ? 'elevation-cancelled'
          : `elevation-failed: ${failure?.stderr || failure?.message || 'no result'}`,
      };
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { scripts, POWERSHELL, run };

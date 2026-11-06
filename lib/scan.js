// LAN printer discovery: TCP port sweep + PJL/JetDirect fingerprint + IPP Get-Printer-Attributes + mDNS.
// Node builtins only. Every helper is defensive: a printer that answers nothing must never throw.
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

/* ------------------------------------------------------------------ mDNS */

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  return Buffer.concat([
    ...parts.map((p) => {
      const b = Buffer.from(p, 'utf8');
      return Buffer.concat([Buffer.from([b.length]), b]);
    }),
    Buffer.from([0]),
  ]);
}

function buildQuery(names) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(names.length, 4);
  return Buffer.concat([
    header,
    ...names.map((n) => Buffer.concat([encodeName(n), Buffer.from([0, 12, 0x00, 0x01])])),
  ]);
}

function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let next = offset;
  let guard = 0;
  while (guard++ < 64) {
    const len = buf[offset];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) next = offset + 2;
      jumped = true;
      offset = ptr;
      continue;
    }
    if (len === 0) {
      if (!jumped) next = offset + 1;
      break;
    }
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('utf8'));
    offset += 1 + len;
  }
  return { name: labels.join('.'), next };
}

function parseRecords(buf) {
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const { next } = readName(buf, off);
    off = next + 4;
  }
  const out = [];
  for (let i = 0; i < an; i++) {
    if (off + 10 > buf.length) break;
    const { name, next } = readName(buf, off);
    off = next;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    const rdataOff = off + 10;
    if (rdataOff + rdlen > buf.length) break;
    const rdata = buf.subarray(rdataOff, rdataOff + rdlen);
    off = rdataOff + rdlen;
    let data = null;
    try {
      if (type === 12) data = readName(buf, rdataOff).name;
      else if (type === 33) {
        data = {
          port: rdata.readUInt16BE(4),
          target: readName(buf, rdataOff + 6).name,
        };
      } else if (type === 16) {
        const txt = {};
        let p = 0;
        while (p < rdata.length) {
          const l = rdata[p];
          const pair = rdata.subarray(p + 1, p + 1 + l).toString('utf8');
          const eq = pair.indexOf('=');
          if (eq > 0) txt[pair.slice(0, eq)] = pair.slice(eq + 1);
          p += 1 + l;
        }
        data = txt;
      } else if (type === 1) data = [...rdata].join('.');
      else data = rdata.toString('hex').slice(0, 64);
    } catch {
      data = null;
    }
    out.push({ name, type, data });
  }
  return out;
}

async function mdnsBrowse(timeoutMs = 2200) {
  return new Promise((resolve) => {
    const found = [];
    const seen = new Set();
    const sockets = [];
    const take = (msg) => {
      try {
        for (const rec of parseRecords(msg)) {
          const key = `${rec.name}|${rec.type}|${JSON.stringify(rec.data)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(rec);
        }
      } catch {
        /* malformed packet */
      }
    };
    const queries = ['_ipp._tcp.local', '_pdl-datastream._tcp.local', '_printer._tcp.local', '_ippusb._tcp.local'];
    try {
      const shared = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      shared.on('message', take);
      shared.on('error', () => {});
      shared.bind(MDNS_PORT, () => {
        try {
          shared.addMembership(MDNS_ADDR);
        } catch {
          /* no multicast on this NIC */
        }
        const q = buildQuery(queries);
        shared.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR);
        setTimeout(() => {
          try {
            shared.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR);
          } catch {}
        }, 500);
      });
      sockets.push(shared);
    } catch {
      /* ignore */
    }
    try {
      const unicast = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      unicast.on('message', take);
      unicast.on('error', () => {});
      unicast.bind(0, () => {
        const q = buildQuery(queries);
        unicast.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR);
      });
      sockets.push(unicast);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {}
      }
      resolve(found);
    }, timeoutMs);
  });
}

/** Turn raw mDNS records into service instances with hostname + ipv4 + model hints. */
export function foldMdns(records) {
  const byInstance = new Map();
  const hostIp = new Map();
  for (const rec of records) {
    if (rec.type === 1 && typeof rec.data === 'string' && rec.name.endsWith('.local')) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(rec.data)) hostIp.set(rec.name.toLowerCase(), rec.data);
    }
  }
  for (const rec of records) {
    if (rec.type !== 12 || typeof rec.data !== 'string') continue;
    const service = rec.name.toLowerCase();
    if (!/^_(ipp|ipps|pdl-datastream|printer|ippusb)/.test(service)) continue;
    const inst = byInstance.get(rec.data) ?? { instance: rec.data, service, host: null, port: null, txt: {}, ip: null };
    inst.service = service;
    byInstance.set(rec.data, inst);
  }
  for (const rec of records) {
    if (!byInstance.has(rec.name)) continue;
    const inst = byInstance.get(rec.name);
    if (rec.type === 33) {
      inst.host = rec.data.target;
      inst.port = rec.data.port;
    } else if (rec.type === 16) {
      Object.assign(inst.txt, rec.data);
    }
  }
  for (const inst of byInstance.values()) {
    if (inst.host) inst.ip = hostIp.get(inst.host.toLowerCase()) ?? null;
  }
  return [...byInstance.values()];
}

/* ---------------------------------------------------------------- TCP/RAW */

export function probeTcp(host, port, timeoutMs = 320) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** PJL INFO ID over RAW/9100 — the most reliable model name a printer reports. */
export function pjlInfo(host, timeoutMs = 1400, port = 9100) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let text = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(text.replace(/\u0000/g, ''));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(Buffer.from('\u001b%-12345X@PJL INFO ID\r\n\u001b%-12345X@PJL INFO CONFIG\r\n\u001b%-12345X\r\n', 'latin1'));
    });
    socket.on('data', (d) => {
      text += d.toString('latin1');
      if (text.length > 20000) done();
    });
    socket.once('timeout', done);
    socket.once('close', done);
    socket.once('error', done);
    socket.connect(port, host);
  });
}

/** Parse `@PJL INFO ID` and `@PJL INFO CONFIG` payloads into model/serial hints. */
export function parsePjl(text) {
  const clean = text.replace(/\u001b%-12345X/g, '').replace(/\r/g, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const model = [];
  let serial = null;
  let capturing = false;
  for (const line of lines) {
    if (/^@PJL\s+INFO\s+ID/i.test(line)) {
      capturing = true;
      continue;
    }
    if (/^@PJL/i.test(line)) {
      capturing = false;
      continue;
    }
    if (!capturing) {
      const m = /SERIAL\s*[:=]\s*"?([A-Za-z0-9-]+)/i.exec(line);
      if (m) serial = m[1];
      continue;
    }
    if (/^[@\u000c]/.test(line)) continue;
    if (line.length && line.length < 120) model.push(line.replace(/^"+|"+$/g, '').trim());
  }
  return { model: model[0] ?? null, serial };
}

/* ------------------------------------------------------------------- IPP */

function ippRequest(uri) {
  const chunks = [];
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    chunks.push(b);
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    chunks.push(b);
  };
  const attr = (tag, name, value) => {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    chunks.push(Buffer.from([tag]));
    u16(n.length);
    chunks.push(n);
    u16(v.length);
    chunks.push(v);
  };
  u16(0x0200);
  u16(0x000b);
  u32(1);
  chunks.push(Buffer.from([0x01]));
  attr(0x47, 'attributes-charset', 'utf-8');
  attr(0x48, 'attributes-natural-language', 'en');
  attr(0x45, 'printer-uri', uri);
  for (const name of ['printer-make-and-model', 'printer-info', 'printer-name', 'printer-uuid']) {
    attr(0x44, 'requested-attributes', name);
  }
  chunks.push(Buffer.from([0x03]));
  return Buffer.concat(chunks);
}

function parseIppAttrs(body) {
  if (!body || body.length < 8) return null;
  let off = 8;
  const attrs = {};
  while (off < body.length) {
    const tag = body[off];
    if (tag === 0x03) break;
    if (tag <= 0x05) {
      off += 1;
      continue;
    }
    if (off + 5 > body.length) break;
    const nameLen = body.readUInt16BE(off + 1);
    const name = body.toString('utf8', off + 3, off + 3 + nameLen);
    const valueLen = body.readUInt16BE(off + 3 + nameLen);
    const valueOff = off + 5 + nameLen;
    const raw = body.subarray(valueOff, valueOff + valueLen);
    off = valueOff + valueLen;
    let value;
    if (tag === 0x41) {
      // textWithLanguage: 2-byte lang len + lang + 2-byte text len + text
      try {
        const langLen = raw.readUInt16BE(0);
        const textLen = raw.readUInt16BE(2 + langLen);
        value = raw.toString('utf8', 4 + langLen, 4 + langLen + textLen);
      } catch {
        value = raw.toString('utf8');
      }
    } else if (tag === 0x48) {
      // nameWithLanguage
      try {
        const langLen = raw.readUInt16BE(0);
        const textLen = raw.readUInt16BE(2 + langLen);
        value = raw.toString('utf8', 4 + langLen, 4 + langLen + textLen);
      } catch {
        value = raw.toString('utf8');
      }
    } else {
      value = raw.toString('utf8');
    }
    if (name && attrs[name] === undefined) attrs[name] = value;
  }
  return attrs;
}

function dechunk(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const lineEnd = buf.indexOf('\r\n', off);
    if (lineEnd < 0) break;
    const size = parseInt(buf.toString('ascii', off, lineEnd).split(';')[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    out.push(buf.subarray(start, start + size));
    off = start + size + 2;
  }
  return Buffer.concat(out);
}

export function ippGetAttributes(host, timeoutMs = 1800, port = 631) {
  const uri = `ipp://${host}/ipp/print`;
  const body = ippRequest(uri);
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const socket = new net.Socket();
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      try {
        const all = Buffer.concat(chunks);
        const sep = all.indexOf('\r\n\r\n');
        if (sep < 0) return resolve(null);
        const head = all.subarray(0, sep).toString('latin1');
        let payload = all.subarray(sep + 4);
        if (/transfer-encoding:\s*chunked/i.test(head)) payload = dechunk(payload);
        else {
          const m = /content-length:\s*(\d+)/i.exec(head);
          if (m) payload = payload.subarray(0, Number(m[1]));
        }
        resolve(parseIppAttrs(payload));
      } catch {
        resolve(null);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const req =
        `POST /ipp/print HTTP/1.1\r\nHost: ${host}\r\n` +
        `Content-Type: application/ipp\r\nContent-Length: ${body.length}\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(Buffer.from(req, 'latin1'));
      socket.write(body);
    });
    socket.on('data', (d) => {
      chunks.push(d);
      size += d.length;
      if (size > 65536) done();
    });
    socket.once('timeout', done);
    socket.once('close', done);
    socket.once('error', done);
    try {
      socket.connect(port, host);
    } catch {
      done();
    }
  });
}

/* ------------------------------------------------------------------- HTTP */

export function httpTitle(host, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const chunks = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      try {
        const all = Buffer.concat(chunks).toString('utf8');
        const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(all)?.[1]?.trim() ?? null;
        const server = /^server:\s*(.+)$/im.exec(all)?.[1]?.trim() ?? null;
        resolve({ title, server });
      } catch {
        resolve(null);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: printer-warden\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (d) => {
      chunks.push(d);
      if (Buffer.concat(chunks).length > 24000) done();
    });
    socket.once('timeout', done);
    socket.once('close', done);
    socket.once('error', done);
    try {
      socket.connect(80, host);
    } catch {
      done();
    }
  });
}

/* -------------------------------------------------------------------- ARP */

export function arpTable() {
  return new Promise((resolve) => {
    const map = new Map();
    execFile('arp.exe', ['-a'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) return resolve(map);
      const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/gi;
      let m;
      while ((m = re.exec(String(stdout))) !== null) {
        map.set(m[1], m[2].replace(/-/g, ':').toLowerCase());
      }
      resolve(map);
    });
  });
}

/* ------------------------------------------------------------------ scan */

export function localSubnets() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const list of Object.values(nics)) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue;
      const ip = nic.address.split('.').map(Number);
      const mask = (nic.netmask || '255.255.255.0').split('.').map(Number);
      const block = (~mask[3] | 0) & 0xff;
      if (block < 2 || block > 1024) continue;
      const base = ip[3] & mask[3];
      out.push({ address: nic.address, prefix: `${ip[0]}.${ip[1]}.${ip[2]}`, base, block });
    }
  }
  return out;
}

function scanHosts(subnets) {
  const hosts = [];
  for (const s of subnets) {
    for (let i = 1; i < s.block; i++) {
      const host = `${s.prefix}.${s.base + i}`;
      if (host === s.address) continue;
      hosts.push(host);
    }
  }
  return hosts;
}

/** Sweep the LAN for printer-ish ports. Returns Map<ip, Set<port>>. */
export async function sweep(subnets, { ports = [9100, 631, 515, 80], timeoutMs = 320, concurrency = 96 } = {}) {
  const hosts = scanHosts(subnets);
  const found = new Map();
  let index = 0;
  const worker = async () => {
    while (index < hosts.length) {
      const host = hosts[index++];
      for (const port of ports) {
        if (await probeTcp(host, port, timeoutMs)) {
          if (!found.has(host)) found.set(host, new Set());
          found.get(host).add(port);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

function modelKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b(series|laser|mfp|printer|hp|hewlett|packard)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Models match when they share a 3-4 digit model family number (1136 ≈ 1136w). */
export function modelsMatch(a, b) {
  const nums = (s) => new Set((String(s ?? '').match(/\d{3,4}/g) ?? []).map((n) => n.replace(/^0+/, '')));
  const left = nums(a);
  if (left.size === 0) return false;
  for (const n of nums(b)) if (left.has(n)) return true;
  const ka = modelKey(a);
  const kb = modelKey(b);
  if (!ka || !kb) return false;
  return ka.includes(kb) || kb.includes(ka);
}

/** A human label for one discovered device. */
function labelFor(entry) {
  return entry.model || entry.mdns?.txt?.ty || entry.mdns?.instance || entry.httpTitle || `打印机 ${entry.ip}`;
}

/**
 * Full LAN scan. Returns candidates that look like printers, strongest first.
 * @param {{timeoutMs?: number, concurrency?: number}} options
 */
export async function scanLan(options = {}) {
  const subnets = localSubnets();
  if (subnets.length === 0) return { candidates: [], notes: ['没有可用的局域网网卡'] };
  const [arp, mdnsRecords, found] = await Promise.all([
    arpTable(),
    mdnsBrowse(options.mdnsMs ?? 2200).catch(() => []),
    sweep(subnets, options),
  ]);
  const services = foldMdns(mdnsRecords);
  const mdnsInstances = services.filter((s) => s.ip);
  const candidates = [];

  for (const [ip, portSet] of found) {
    const ports = [...portSet];
    const entry = {
      ip,
      mac: arp.get(ip) ?? null,
      ports,
      model: null,
      serial: null,
      mdns: mdnsInstances.find((s) => s.ip === ip) ?? null,
      ipp: null,
      httpTitle: null,
      score: 0,
      evidence: [],
    };
    if (ports.includes(9100)) {
      const pjl = parsePjl(await pjlInfo(ip));
      if (pjl.model) {
        entry.model = pjl.model;
        entry.serial = pjl.serial;
        entry.score += 5;
        entry.evidence.push('RAW/9100 + PJL INFO ID');
      } else {
        entry.score += 1;
        entry.evidence.push('RAW/9100');
      }
    }
    if (ports.includes(631)) {
      const attrs = await ippGetAttributes(ip);
      if (attrs) {
        entry.ipp = attrs;
        entry.model = entry.model || attrs['printer-make-and-model'] || attrs['printer-info'] || null;
        entry.score += 4;
        entry.evidence.push('IPP/631');
      }
    }
    if (entry.mdns) {
      entry.model = entry.model || entry.mdns.txt?.ty || entry.mdns.txt?.mdl || null;
      entry.score += 3;
      entry.evidence.push('mDNS');
    }
    if (!entry.model && ports.includes(80)) {
      const http = await httpTitle(ip);
      entry.httpTitle = http?.title ?? null;
      if (/print|hp |laser|mfp|打印机|打印/i.test(`${http?.title ?? ''} ${http?.server ?? ''}`)) {
        entry.score += 2;
        entry.evidence.push('HTTP title');
      }
    }
    if (entry.mdns?.txt?.usb_MDL && !entry.model) entry.model = entry.mdns.txt.usb_MDL;
    entry.name = labelFor(entry);
    entry.kind = entry.score >= 3 ? 'printer' : entry.score >= 2 ? 'maybe' : 'device';
    if (entry.score > 0) candidates.push(entry);
  }

  // mDNS-only printers (no open scanned port) still count.
  for (const svc of mdnsInstances) {
    if (candidates.some((c) => c.ip === svc.ip)) continue;
    candidates.push({
      ip: svc.ip,
      mac: arp.get(svc.ip) ?? null,
      ports: svc.port ? [svc.port] : [],
      model: svc.txt?.ty ?? svc.txt?.mdl ?? null,
      serial: svc.txt?.sn ?? null,
      mdns: svc,
      ipp: null,
      httpTitle: null,
      score: 3,
      evidence: ['mDNS'],
      name: svc.txt?.ty ?? svc.instance,
      kind: 'printer',
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return {
    candidates,
    notes: [],
    scannedAt: new Date().toISOString(),
    subnet: subnets.map((s) => `${s.prefix}.0/${s.block === 255 ? 24 : 24}`),
    hostsAlive: found.size,
  };
}

/* ------------------------------------------------------------- resolving */

/** Resolve a candidate's stable hostname if the OS resolver can turn it into the scanned IP. */
export async function resolveStableHost(candidate) {
  const names = [];
  if (candidate.mdns?.host) names.push(candidate.mdns.host.replace(/\.$/, ''));
  try {
    const ptr = await dns.reverse(candidate.ip);
    for (const name of ptr) {
      const clean = String(name ?? '').replace(/\.$/, '');
      if (clean && !clean.endsWith('.in-addr.arpa') && !names.includes(clean)) names.push(clean);
    }
  } catch {
    /* no PTR record */
  }
  for (const base of names) {
    // A single-label DHCP name may only resolve as an absolute FQDN (trailing dot);
    // that spelling is what lets the spooler keep working across IP changes.
    for (const host of [base, `${base}.`]) {
      try {
        const res = await dns.lookup(host, { all: true });
        if (res.some((r) => r.address === candidate.ip)) {
          return { host, kind: host.endsWith('.') ? 'dns-fqdn' : 'dns-name', resolvedTo: candidate.ip };
        }
      } catch {
        /* try the next spelling */
      }
    }
  }
  return { host: candidate.ip, kind: 'ip' };
}

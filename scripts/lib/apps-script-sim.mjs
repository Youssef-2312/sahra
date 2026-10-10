// A local stand-in for the Google Apps Script services that
// backup/apps-script/Code.gs uses, so the real script runs unchanged in Node
// against a local Worker (scripts/backup-e2e.mjs). Drive is a folder on disk;
// UrlFetchApp is a synchronous HTTP client (a worker thread + Atomics.wait),
// like the real one. Byte arrays are plain arrays of signed bytes (-128..127),
// as in Apps Script, so the script's own hex and hash code is exercised.
//
// It proves the script's logic and the file layout. It cannot prove real Drive
// behaviour, real quotas (6 minutes per run, 90 minutes per day of triggers,
// UrlFetch and Drive limits) or real timings.

import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInContext, createContext } from "node:vm";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";

const toSigned = (buf) => Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
const toBuf = (v) => (typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(Int8Array.from(v).buffer));

function syncHttp() {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const { port, flag } = workerData;
    port.on("message", async ({ id, url, init }) => {
      let out;
      try {
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
        out = { status: r.status, headers: Object.fromEntries(r.headers), body: new Uint8Array(await r.arrayBuffer()) };
      } catch (e) { out = { error: String(e && e.message || e) }; }
      port.postMessage({ id, ...out });
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });`, { eval: true, workerData: { port: port2, flag }, transferList: [port2] });
  worker.unref();
  let requestId = 0;
  return {
    fetch(url, init) {
      const id = ++requestId;
      const deadline = Date.now() + 30_000;
      port1.postMessage({ id, url, init });
      // Notification can arrive before Node exposes the posted message. A timed
      // out response must also never become the next request's response.
      while (Date.now() < deadline) {
        let m;
        while ((m = receiveMessageOnPort(port1))) {
          if (m.message.id !== id) continue;
          if (m.message.error) throw new Error(`Address unavailable: ${url} (${m.message.error})`);
          return m.message;
        }
        Atomics.store(flag, 0, 0);
        Atomics.wait(flag, 0, 0, 50);
      }
      throw new Error("no HTTP answer");
    },
    close: () => worker.terminate(),
  };
}

class Blob {
  constructor(bytes, type = "application/octet-stream", name = null) { this.bytes = bytes; this.type = type; this.name = name; }
  getBytes() { return toSigned(this.bytes); }
  getDataAsString() { return this.bytes.toString("utf8"); }
  getContentType() { return this.type; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
}

/** Drive on disk. Folder and file ids are stable strings; trashed items move to <root>/.trash. */
class Drive {
  constructor(rootDir) {
    this.root = rootDir;
    mkdirSync(join(rootDir, ".trash"), { recursive: true });
    this.paths = new Map([["root", rootDir]]);
    this.names = new Map();
    this.n = 0;
    this.removed = [];
  }
  idFor(path, name) {
    for (const [id, p] of this.paths) if (p === path) return id;
    const id = `id${++this.n}`;
    this.paths.set(id, path);
    this.names.set(id, name);
    return id;
  }
  nameOf(id, path) { return this.names.get(id) ?? path.split("/").pop(); }
  uniquePath(dir, name) {
    // Drive allows two items with one name; on disk the second gets a suffix.
    let p = join(dir, name);
    for (let i = 2; existsSync(p); i++) p = join(dir, `${name}~${i}`);
    return p;
  }
  /** The Drive advanced service's Files.remove: gone for good (not in the trash). */
  remove(id) {
    const p = this.paths.get(id);
    if (!p || !existsSync(p)) throw new Error(`File not found: ${id}`);
    rmSync(p, { recursive: true, force: true });
    this.paths.delete(id);
    this.removed.push(id);
  }
  trash(id) {
    const p = this.paths.get(id);
    const dest = this.uniquePath(join(this.root, ".trash"), p.split("/").pop());
    renameSync(p, dest);
    this.paths.set(id, dest);
  }
  folder(id) {
    const d = this;
    const path = () => d.paths.get(id);
    const iter = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
    const children = (dirs) => readdirSync(path()).filter((n) => n !== ".trash")
      .map((n) => join(path(), n)).filter((p) => statSync(p).isDirectory() === dirs)
      .map((p) => { const cid = d.idFor(p); return dirs ? d.folder(cid) : d.file(cid); });
    return {
      getId: () => id,
      getName: () => d.nameOf(id, path()),
      setName: (n) => { const to = d.uniquePath(join(path(), ".."), n); renameSync(path(), to); d.paths.set(id, to); d.names.set(id, n); },
      setTrashed: (t) => { if (t) d.trash(id); },
      createFolder: (name) => { const p = d.uniquePath(path(), name); mkdirSync(p); const fid = d.idFor(p, name); return d.folder(fid); },
      createFile: (blob) => { const p = d.uniquePath(path(), blob.getName()); writeFileSync(p, blob.bytes); return d.file(d.idFor(p, blob.getName())); },
      getFolders: () => iter(children(true)),
      getFoldersByName: (n) => iter(children(true).filter((f) => f.getName() === n)),
      getFilesByName: (n) => iter(children(false).filter((f) => f.getName() === n)),
    };
  }
  file(id) {
    const d = this;
    const path = () => d.paths.get(id);
    return {
      getId: () => id,
      getName: () => d.nameOf(id, path()),
      getSize: () => statSync(path()).size,
      getBlob: () => new Blob(readFileSync(path()), "application/octet-stream", d.nameOf(id, path())),
      setContent: (text) => { writeFileSync(path(), text); },
      setTrashed: (t) => { if (t) d.trash(id); },
    };
  }
}

/**
 * Loads Code.gs into a fresh context with the simulated services.
 * @param {{ code: string, driveDir: string, props: Record<string,string>, timeZone?: string, overrides?: Record<string, unknown> }} o
 */
export function loadAppsScript(o) {
  const http = syncHttp();
  const drive = new Drive(o.driveDir);
  const props = new Map(Object.entries(o.props));
  const sim = { mails: [], triggers: [], logs: [], fetches: 0, requests: [], http, drive, props };
  const tz = o.timeZone ?? "Africa/Cairo";
  const formatDate = (date, zone, fmt) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date).map((p) => [p.type, p.value]));
    const known = { "H": String(Number(parts.hour)), "yyyy-MM-dd": `${parts.year}-${parts.month}-${parts.day}`, "yyyy-MM-dd'T'HHmm'Z'": `${parts.year}-${parts.month}-${parts.day}T${parts.hour}${parts.minute}Z` };
    if (!(fmt in known)) throw new Error(`formatDate: format ${fmt} not simulated`);
    return known[fmt];
  };
  const services = {
    UrlFetchApp: {
      fetch(url, opts = {}) {
        sim.fetches++;
        const headers = { ...(opts.headers ?? {}), ...(opts.contentType ? { "content-type": opts.contentType } : {}) };
        const r = http.fetch(url, { method: (opts.method ?? "get").toUpperCase(), headers, body: opts.payload, redirect: opts.followRedirects === false ? "manual" : "follow" });
        sim.requests.push({ method: (opts.method ?? "get").toUpperCase(), url, status: r.status, payload: opts.payload ?? null });
        const body = Buffer.from(r.body);
        if (r.status >= 400 && !opts.muteHttpExceptions) throw new Error(`Request failed for ${url} returned code ${r.status}`);
        return {
          getResponseCode: () => r.status,
          getContent: () => toSigned(body),
          getContentText: () => body.toString("utf8"),
          getHeaders: () => r.headers,
          getAllHeaders: () => r.headers,
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (alg, v) => toSigned(createHash(alg).update(toBuf(v)).digest()),
      computeHmacSha256Signature: (v, key) => toSigned(createHmac("sha256", toBuf(key)).update(toBuf(v)).digest()),
      base64DecodeWebSafe: (s) => {
        if (!/^[A-Za-z0-9_-]*=*$/.test(s) || s.length % 4) throw new Error("Could not decode string.");
        return toSigned(Buffer.from(s, "base64url"));
      },
      newBlob: (data, type, name) => new Blob(toBuf(data), type, name ?? null),
      gzip: (blob, name) => new Blob(gzipSync(blob.bytes), "application/x-gzip", name ?? `${blob.getName()}.gz`),
      ungzip: (blob) => new Blob(gunzipSync(blob.bytes), "application/octet-stream", null),
      formatDate,
      sleep: () => {},
    },
    Drive: { Files: { remove: (id) => drive.remove(id) } },
    DriveApp: { getFolderById: (id) => { if (!drive.paths.has(id)) throw new Error(`No item with the given ID could be found: ${id}`); return drive.folder(id); } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => {
          if (String(v).length > 9 * 1024) throw new Error(`Script Property ${k} over 9 KB (${String(v).length})`);
          props.set(k, String(v));
        },
        deleteProperty: (k) => { props.delete(k); },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: {
      getProjectTriggers: () => sim.triggers.slice(),
      deleteTrigger: (t) => { sim.triggers = sim.triggers.filter((x) => x !== t); },
      newTrigger: (handler) => {
        const t = { handler, getHandlerFunction: () => handler };
        const b = { timeBased: () => b, after: (ms) => { t.after = ms; return b; }, everyHours: (n) => { t.everyHours = n; return b; }, create: () => { sim.triggers.push(t); return t; } };
        return b;
      },
    },
    MailApp: { sendEmail: (to, subject, body) => { sim.mails.push({ to, subject, body }); } },
    Session: { getScriptTimeZone: () => tz, getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) },
    console: { log: (m) => sim.logs.push(String(m)), warn: (m) => sim.logs.push(String(m)), error: (m) => sim.logs.push(String(m)) },
  };
  const ctx = createContext({ ...services, Error });
  runInContext(o.code, ctx, { filename: "Code.gs" });
  for (const [k, v] of Object.entries(o.overrides ?? {})) runInContext(`${k} = ${JSON.stringify(v)};`, ctx);
  sim.call = (fn) => runInContext(`${fn}()`, ctx);
  return sim;
}

/** Async facade: keep Miniflare's host event loop free while Apps Script does
 * synchronous HTTP. State returns after each call, just like Script Properties. */
export function loadAppsScriptAsync(o) {
  const worker = new Worker(new URL('./apps-script-worker.mjs', import.meta.url), { workerData: o });
  const pending = new Map();
  let seq = 0;
  const sim = { props: new Map(Object.entries(o.props)), mails: [], triggers: [], fetches: 0,
    drive: { removed: [] }, http: { close: () => worker.terminate() } };
  worker.on('message', m => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) { p.reject(new Error(m.error)); return; }
    sim.props.clear();
    for (const [k, v] of m.props) sim.props.set(k, v);
    sim.mails = m.mails; sim.triggers = m.triggers; sim.fetches = m.fetches;
    sim.drive.removed = m.removed;
    p.resolve(m.result);
  });
  worker.on('error', e => { for (const p of pending.values()) p.reject(e); pending.clear(); });
  worker.on('exit', code => {
    for (const p of pending.values()) p.reject(new Error(`Apps Script simulation exited (${code})`));
    pending.clear();
  });
  sim.call = fn => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, props: [...sim.props] });
  });
  return sim;
}

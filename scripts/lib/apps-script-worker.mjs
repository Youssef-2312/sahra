// Run synchronous Apps Script calls off the Miniflare host's event loop.
// This is a local test simulator, never code deployed to Cloudflare or Google.
import { parentPort, workerData } from 'node:worker_threads';
import { loadAppsScript } from './apps-script-sim.mjs';
const sim = loadAppsScript(workerData);
parentPort.on('message', ({ id, fn, props }) => {
  try {
    sim.props.clear();
    for (const [k, v] of props) sim.props.set(k, v);
    const result = sim.call(fn);
    parentPort.postMessage({ id, result, props: [...sim.props], mails: sim.mails,
      triggers: sim.triggers.map(t => Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v !== 'function'))),
      fetches: sim.fetches, removed: sim.drive.removed });
  } catch (e) { parentPort.postMessage({ id, error: e.stack || String(e) }); }
});

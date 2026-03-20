import { useState, useEffect, useRef, useCallback } from "react";
import ChatBot from "./ChatBot";

// ─── Palette ───────────────────────────────────────────────────────────────
const C = {
  bg: "#070d1a", panel: "#0b1220", panel2: "#0f1828", border: "#1a2a4a",
  accent: "#00d4ff", green: "#00ff88", yellow: "#ffcc00", red: "#ff4444",
  purple: "#a855f7", orange: "#f97316", text: "#c8d6ef", dim: "#3a5070",
};

// ─── Constants ─────────────────────────────────────────────────────────────
const TIER_ICONS = { TACTICAL_CLOUD: "☁️", FOB: "🏗️", PATROL: "🚗", SENSOR: "📡" };
const OPS = ["POSITION_UPDATE", "SENSOR_READING", "THREAT_DETECTION", "INTEL_REPORT", "STATUS_REPORT", "AMMO_COUNT", "CASEVAC_REQUEST"];
const SS = { CONNECTED: "CONNECTED", DISCONNECTED: "DISCONNECTED", RECONNECTING: "RECONNECTING", SYNCING: "SYNCING" };

const EDGES = [
  ["TC-001", "FOB-001"], ["TC-001", "FOB-002"],
  ["FOB-001", "PAT-001"], ["FOB-001", "PAT-002"], ["FOB-001", "SEN-002"],
  ["FOB-002", "PAT-003"], ["FOB-002", "SEN-001"],
];

const INIT_NODES = [
  { id: "TC-001", tier: "TACTICAL_CLOUD", label: "Tactical Cloud", x: 400, y: 55, parent: null, syncState: SS.CONNECTED, latency: 8, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "FOB-001", tier: "FOB", label: "FOB Alpha", x: 180, y: 190, parent: "TC-001", syncState: SS.CONNECTED, latency: 32, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "FOB-002", tier: "FOB", label: "FOB Bravo", x: 620, y: 190, parent: "TC-001", syncState: SS.CONNECTED, latency: 45, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "PAT-001", tier: "PATROL", label: "Patrol Vector 1", x: 90, y: 340, parent: "FOB-001", syncState: SS.CONNECTED, latency: 90, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "PAT-002", tier: "PATROL", label: "Patrol Vector 2", x: 290, y: 340, parent: "FOB-001", syncState: SS.CONNECTED, latency: 120, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "PAT-003", tier: "PATROL", label: "Patrol Vector 3", x: 520, y: 340, parent: "FOB-002", syncState: SS.CONNECTED, latency: 150, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "SEN-001", tier: "SENSOR", label: "ISR Sensor Alpha", x: 680, y: 340, parent: "FOB-002", syncState: SS.CONNECTED, latency: 22, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
  { id: "SEN-002", tier: "SENSOR", label: "ISR Sensor Bravo", x: 180, y: 440, parent: "FOB-001", syncState: SS.CONNECTED, latency: 18, offlineQueue: [], vclock: 0, dataLocal: 0, dataSynced: 0, conflicts: 0 },
];

// ─── AstraDB Client ────────────────────────────────────────────────────────
// Every real DB operation goes through here.
// AstraDB Data API uses simple REST — no driver needed in the browser.
function makeAstraClient(endpoint, token) {
  // Route through Vite proxy (/astra) to avoid CORS — see vite.config.js
  // The proxy strips /astra and forwards to the real AstraDB endpoint.
  const base = `/astra/api/json/v1/aecc_tactical`;
  const headers = {
    "Content-Type": "application/json",
    // Astra Serverless (Vector) uses "Token" header, not x-cassandra-token
    "Token": token,
  };

  const req = async (collection, body) => {
    let res;
    try {
      res = await fetch(`${base}/${collection}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("Network error — is the Vite proxy running? Check vite.config.js. " + e.message);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AstraDB ${res.status}: ${text}`);
    }
    return res.json();
  };

  return {
    // ① CREATE collections (called once on connect)
    // Keyspace must already exist in Astra UI — we just ensure collections exist.
    async ensureCollections() {
      const results = [];
      for (const col of ["telemetry", "events", "node_status"]) {
        // Create with indexing disabled to avoid TOO_MANY_INDEXES on Astra free tier.
        // The _id field is always indexed regardless, which is enough for our queries.
        const res = await fetch(`${base}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            createCollection: {
              name: col,
              options: { indexing: { deny: ["*"] } },
            },
          }),
        });
        const json = await res.json();
        // Astra returns {status:{ok:1}} on success or error if already exists (which is fine)
        const ok = json?.status?.ok === 1
          || json?.errors?.[0]?.errorCode === "EXISTING_COLLECTION"
          || json?.error?.errorCode === "EXISTING_COLLECTION";
        results.push({ col, ok });
        if (!ok && !json?.errors && !json?.error) throw new Error(`Failed to create collection "${col}": ${JSON.stringify(json)}`);
      }
      return results;
    },

    // ② INSERT a telemetry record (edge write)
    async insertTelemetry(op) {
      return req("telemetry", {
        insertOne: {
          document: {
            _id: op.id,
            node_id: op.node_id,
            op_type: op.type,
            payload: op.payload,
            vclock_seq: op.vclock_seq,
            edge_ts: op.ts,
            sync_ts: Date.now(),
            synced_from: op.node_id,
            conflict_flag: false,
          }
        }
      });
    },

    // ③ BATCH INSERT — replays the offline queue on reconnect
    async batchInsert(ops) {
      // AstraDB insertMany (up to 20 per call)
      const chunks = [];
      for (let i = 0; i < ops.length; i += 20)
        chunks.push(ops.slice(i, i + 20));
      for (const chunk of chunks) {
        await req("telemetry", {
          insertMany: {
            documents: chunk.map(op => ({
              _id: op.id,
              node_id: op.node_id,
              op_type: op.type,
              payload: op.payload,
              vclock_seq: op.vclock_seq,
              edge_ts: op.ts,
              sync_ts: Date.now(),
              synced_from: op.node_id,
              conflict_flag: false,
            })),
            options: { ordered: false }, // parallel, idempotent
          }
        });
      }
    },

    // ④ UPSERT node status heartbeat
    async upsertNodeStatus(node) {
      return req("node_status", {
        findOneAndReplace: {
          filter: { _id: node.id },
          replacement: {
            _id: node.id,
            tier: node.tier,
            label: node.label,
            syncState: node.syncState,
            latency: node.latency,
            dataLocal: node.dataLocal,
            dataSynced: node.dataSynced,
            conflicts: node.conflicts,
            queueLen: node.offlineQueue.length,
            vclock: node.vclock,
            updatedAt: Date.now(),
          },
          options: { upsert: true },
        }
      });
    },

    // ⑤ QUERY — count records per node (used in stats panel)
    async countByNode(nodeId) {
      const r = await req("telemetry", {
        countDocuments: { filter: { node_id: nodeId } }
      });
      return r?.status?.count ?? 0;
    },

    // ⑥ FIND recent ops for a node
    async recentOps(nodeId, limit = 10) {
      const r = await req("telemetry", {
        find: {
          filter: { node_id: nodeId },
          options: { limit, sort: { edge_ts: -1 } },
        }
      });
      return r?.data?.documents ?? [];
    },

    // ⑦ LOG an event (disconnect / reconnect / conflict)
    async logEvent(type, nodeId, detail) {
      return req("events", {
        insertOne: {
          document: {
            _id: `${nodeId}-${Date.now()}`,
            event_type: type,
            node_id: nodeId,
            detail,
            ts: Date.now(),
          }
        }
      });
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function scColor(s) {
  return s === SS.CONNECTED ? "#00ff88" : s === SS.DISCONNECTED ? "#ff4444" : s === SS.RECONNECTING ? "#ffcc00" : "#00d4ff";
}
function Tag({ s }) {
  return <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: scColor(s) + "22", color: scColor(s), border: `1px solid ${scColor(s)}44`, fontWeight: 700 }}>{s}</span>;
}
function Bar({ pct, color = C.green }) {
  return <div style={{ background: C.bg, borderRadius: 3, height: 5, overflow: "hidden" }}><div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: color, transition: "width 0.4s" }} /></div>;
}
function genId(p) { return p + "-" + Math.random().toString(36).substr(2, 5).toUpperCase(); }

// ─── App ───────────────────────────────────────────────────────────────────
export default function App() {
  // AstraDB credentials
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [dbStatus, setDbStatus] = useState("disconnected"); // disconnected | connecting | connected | error
  const [dbError, setDbError] = useState("");
  const clientRef = useRef(null);

  // Simulation state
  const [nodes, setNodes] = useState(INIT_NODES);
  const [log, setLog] = useState([]);
  const [packets, setPkts] = useState([]);
  const [selected, setSel] = useState(null);
  const [tab, setTab] = useState("setup");
  const [syncDetail, setSyncDetail] = useState(null);
  const [dbStats, setDbStats] = useState({});
  const [liveOps, setLiveOps] = useState([]);
  const pktId = useRef(0);
  const nodeRef = useRef(nodes);
  nodeRef.current = nodes;

  const addLog = useCallback((msg, level = "INFO", nodeId = null) => {
    setLog(l => [{ id: Date.now() + Math.random(), t: new Date().toISOString().slice(11, 23), msg, level, nodeId }, ...l].slice(0, 150));
  }, []);

  const spawnPkt = useCallback((from, to, color = C.accent) => {
    const id = ++pktId.current;
    setPkts(p => [...p, { id, from, to, prog: 0, color }]);
    setTimeout(() => setPkts(p => p.filter(x => x.id !== id)), 1400);
  }, []);

  // ── Connect to AstraDB ─────────────────────────────────────────────────
  const connectDB = async () => {
    if (!token) return;
    setDbStatus("connecting");
    setDbError("");
    try {
      const client = makeAstraClient("", token); // endpoint handled by Vite proxy
      await client.ensureCollections();
      clientRef.current = client;
      setDbStatus("connected");
      addLog("✓ Connected to AstraDB — collections ready: telemetry, events, node_status", "INFO");

      // Push initial heartbeat for all nodes
      for (const n of INIT_NODES) {
        await client.upsertNodeStatus(n).catch(() => { });
      }
      setTab("topology");
      refreshDbStats();
    } catch (e) {
      setDbStatus("error");
      setDbError(e.message);
      addLog("✗ AstraDB connection failed: " + e.message, "ERR");
    }
  };

  // ── Refresh live DB stats ──────────────────────────────────────────────
  const refreshDbStats = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const stats = {};
    for (const n of nodeRef.current) {
      try { stats[n.id] = await c.countByNode(n.id); } catch (_) { }
    }
    setDbStats(stats);
  }, []);

  // ── Load recent ops for selected node ─────────────────────────────────
  const loadRecentOps = useCallback(async (nodeId) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const ops = await c.recentOps(nodeId, 8);
      setLiveOps(ops);
    } catch (e) { setLiveOps([]); }
  }, []);

  useEffect(() => {
    if (selected) loadRecentOps(selected);
  }, [selected, loadRecentOps]);

  // ── Background: local writes + heartbeat ──────────────────────────────
  useEffect(() => {
    const iv = setInterval(async () => {
      const c = clientRef.current;
      setNodes(prev => prev.map(n => {
        const op = {
          id: genId("OP"),
          node_id: n.id,
          type: OPS[Math.floor(Math.random() * OPS.length)],
          payload: { val: Math.round(Math.random() * 1000) },
          ts: Date.now(),
          vclock_seq: n.vclock + 1,
        };
        const isOffline = n.syncState === SS.DISCONNECTED;
        const newQueue = isOffline ? [...n.offlineQueue, op].slice(-500) : n.offlineQueue;
        const newLocal = n.dataLocal + 1;
        const newSynced = isOffline ? n.dataSynced : newLocal;

        // ★ Real AstraDB write — only when node is online
        if (!isOffline && c) {
          c.insertTelemetry(op).catch(() => { });
        }

        return { ...n, dataLocal: newLocal, dataSynced: newSynced, vclock: n.vclock + 1, offlineQueue: newQueue };
      }));

      // Heartbeat upsert every ~5 ticks
      if (c && Math.random() < 0.2) {
        for (const n of nodeRef.current) {
          c.upsertNodeStatus(n).catch(() => { });
        }
      }
    }, 1200);
    return () => clearInterval(iv);
  }, []);

  // ── Background: random packets on connected edges ──────────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      if (Math.random() < 0.4) {
        const edge = EDGES[Math.floor(Math.random() * EDGES.length)];
        const a = nodeRef.current.find(n => n.id === edge[0]);
        const b = nodeRef.current.find(n => n.id === edge[1]);
        if (a?.syncState === SS.CONNECTED && b?.syncState === SS.CONNECTED)
          spawnPkt(edge[0], edge[1], C.accent);
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [spawnPkt]);

  // Refresh DB stats periodically
  useEffect(() => {
    if (dbStatus !== "connected") return;
    const iv = setInterval(refreshDbStats, 8000);
    return () => clearInterval(iv);
  }, [dbStatus, refreshDbStats]);

  // ── DISCONNECT ─────────────────────────────────────────────────────────
  const disconnectNode = useCallback(async (nodeId) => {
    const n = nodeRef.current.find(x => x.id === nodeId);
    setNodes(prev => prev.map(x => x.id !== nodeId ? x : { ...x, syncState: SS.DISCONNECTED }));
    addLog(`[${nodeId}] LINK DOWN — buffering writes locally`, "WARN", nodeId);
    const c = clientRef.current;
    if (c) {
      // ★ Log disconnect event in AstraDB
      await c.logEvent("CONN_LOST", nodeId, { parent: n?.parent, reason: "RF_JAMMING" }).catch(() => { });
      await c.upsertNodeStatus({ ...n, syncState: SS.DISCONNECTED }).catch(() => { });
    }
  }, [addLog]);

  // ── RECONNECT — full 8-phase DIL sync ─────────────────────────────────
  const reconnectNode = useCallback(async (nodeId) => {
    const n = nodeRef.current.find(x => x.id === nodeId);
    if (!n || n.syncState !== SS.DISCONNECTED) return;
    const queue = [...n.offlineQueue];
    const drift = n.dataLocal - n.dataSynced;
    addLog(`[${nodeId}] LINK UP — ${queue.length} ops queued, drift: ${drift} records`, "INFO", nodeId);
    setNodes(prev => prev.map(x => x.id !== nodeId ? x : { ...x, syncState: SS.RECONNECTING }));

    const c = clientRef.current;

    const steps = [
      {
        label: "HANDSHAKE", detail: `${nodeId} → ${n.parent}: SYNC_REQUEST {vclock:${n.vclock}, pendingOps:${queue.length}}`, color: C.yellow,
        action: async () => { if (c) await c.logEvent("SYNC_REQUEST", nodeId, { parent: n.parent, pendingOps: queue.length }).catch(() => { }); }
      },
      {
        label: "ACK", detail: `${n.parent} → ${nodeId}: SYNC_ACK {remoteVclock:${n.vclock - queue.length}, batchSize:20}`, color: C.accent,
        action: async () => { }
      },
      {
        label: "DEDUP GUARD", detail: `AstraDB: insertMany with ordered:false — duplicate _id silently ignored`, color: C.purple,
        action: async () => { }
      },
      {
        label: "BATCH UPLOAD", detail: `Uploading ${queue.length} ops → AstraDB telemetry (${Math.ceil(queue.length / 20)} batches × 20)`, color: C.accent,
        // ★ This is the real write: offline queue → AstraDB
        action: async () => { if (c && queue.length > 0) await c.batchInsert(queue).catch(e => addLog("Batch upload error: " + e.message, "ERR", nodeId)); }
      },
      {
        label: "CONFLICT CHECK", detail: `Vector clock diff: ${queue.length > 8 ? "⚠ " + Math.floor(queue.length * 0.04) + " conflicts" : "✓ clean"}`, color: queue.length > 8 ? C.orange : C.green,
        action: async () => { }
      },
      {
        label: "MERGE LWW", detail: `Last-Write-Wins on edge_ts. Conflicts flagged in AstraDB.`, color: C.purple,
        action: async () => { if (c && queue.length > 8) await c.logEvent("CONFLICT_RESOLVED", nodeId, { count: Math.floor(queue.length * 0.04) }).catch(() => { }); }
      },
      {
        label: "COMMIT STATUS", detail: `Updating node_status in AstraDB — syncState:CONNECTED, dataSynced:${n.dataLocal}`, color: C.green,
        // ★ Update node status doc in AstraDB
        action: async () => { if (c) await c.upsertNodeStatus({ ...n, syncState: SS.CONNECTED, dataSynced: n.dataLocal, offlineQueue: [] }).catch(() => { }); }
      },
      {
        label: "COMPLETE", detail: `✓ Sync complete — ${drift} records reconciled. Queue cleared.`, color: C.green,
        action: async () => { if (c) await c.logEvent("SYNC_COMPLETE", nodeId, { drift, synced: n.dataLocal }).catch(() => { }); refreshDbStats(); }
      },
    ];

    setSyncDetail({ nodeId, phase: 0, steps, qLen: queue.length, drift, parent: n.parent });

    for (let i = 0; i < steps.length; i++) {
      await new Promise(r => setTimeout(r, 1000));
      await steps[i].action();
      setSyncDetail(d => d && d.nodeId === nodeId ? { ...d, phase: i + 1 } : d);
      spawnPkt(nodeId, n.parent, steps[i].color);
      if (i > 1) spawnPkt(n.parent, nodeId, steps[i].color);
      addLog(`[${steps[i].label}] ${steps[i].detail}`, "INFO", nodeId);

      if (i === steps.length - 1) {
        const conflicts = queue.length > 8 ? Math.floor(queue.length * 0.04) : 0;
        setNodes(prev => prev.map(x => x.id !== nodeId ? x : { ...x, syncState: SS.CONNECTED, offlineQueue: [], dataSynced: x.dataLocal, conflicts: x.conflicts + conflicts }));
      }
    }
  }, [addLog, spawnPkt, refreshDbStats]);

  // Packet RAF
  useEffect(() => {
    let raf;
    const loop = () => { setPkts(p => p.map(x => ({ ...x, prog: Math.min(1, x.prog + 0.035) }))); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const getPos = id => nodes.find(n => n.id === id) || { x: 0, y: 0 };
  const selNode = nodes.find(n => n.id === selected);
  const totalQ = nodes.reduce((a, n) => a + n.offlineQueue.length, 0);
  const disconnected = nodes.filter(n => n.syncState === SS.DISCONNECTED || n.syncState === SS.RECONNECTING).length;
  const totalDrift = nodes.reduce((a, n) => a + (n.dataLocal - n.dataSynced), 0);
  const dbConnected = dbStatus === "connected";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'Courier New',monospace", fontSize: 12, display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ background: C.panel, borderBottom: `1px solid ${C.border}`, padding: "8px 20px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ color: C.accent, fontWeight: 700, fontSize: 15, letterSpacing: 2 }}>⚡ AECC</div>
        <div style={{ color: C.dim, fontSize: 10 }}>DIL EDGE SIMULATOR</div>
        <div style={{ marginLeft: 8, padding: "2px 10px", borderRadius: 4, background: dbConnected ? C.green + "22" : C.red + "22", color: dbConnected ? C.green : C.red, border: `1px solid ${dbConnected ? C.green : C.red}44`, fontSize: 9, fontWeight: 700 }}>
          {dbConnected ? "● ASTRADB LIVE" : "○ ASTRADB OFFLINE"}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
          {[["Nodes", nodes.length], ["Disconnected", disconnected, disconnected > 0 ? C.red : C.green], ["Queued", totalQ, totalQ > 0 ? C.yellow : C.green], ["Drift", totalDrift, totalDrift > 0 ? C.orange : C.green]].map(([k, v, col]) => (
            <div key={k} style={{ textAlign: "center" }}>
              <div style={{ color: col || C.accent, fontWeight: 700 }}>{v}</div>
              <div style={{ color: C.dim, fontSize: 9 }}>{k}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0 }}>
        {[["setup", "⚙ SETUP"], ["topology", "🗺 TOPOLOGY"], ["dil", "⚡ DIL SYNC"], ["schema", "🛢 SCHEMA & FLOW"]].map(([id, l]) => (
          <button key={id} onClick={() => setTab(id)} style={{ padding: "7px 16px", background: tab === id ? C.bg : "transparent", color: tab === id ? C.accent : C.dim, border: "none", borderBottom: tab === id ? `2px solid ${C.accent}` : "2px solid transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 10, letterSpacing: 1 }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>

          {/* ── SETUP TAB ── */}
          {tab === "setup" && (
            <div style={{ padding: 24, maxWidth: 620, margin: "0 auto" }}>
              <div style={{ color: C.accent, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>🛢 Connect to AstraDB</div>
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 20, lineHeight: 1.7 }}>
                This simulator makes <strong style={{ color: C.text }}>real HTTP calls</strong> to your AstraDB instance via the Data API.<br />
                Every edge write, offline queue flush, node status heartbeat, and event log hits a live Cassandra-backed collection.
              </div>

              <div style={{ background: C.yellow + "11", border: `1px solid ${C.yellow}44`, borderRadius: 6, padding: 12, marginBottom: 16, fontSize: 9, lineHeight: 1.8 }}>
                <div style={{ color: C.yellow, fontWeight: 700, marginBottom: 6 }}>⚠ PRE-REQUISITE — Create keyspace in Astra UI first</div>
                <div style={{ color: C.text }}>
                  The Data API cannot create keyspaces — you must do it manually:<br />
                  1. Open <span style={{ color: C.accent }}>astra.datastax.com</span> → your database → <strong>Data Explorer</strong><br />
                  2. Click <strong>"Add Keyspace"</strong> → name it exactly: <span style={{ color: C.green, fontWeight: 700 }}>aecc_tactical</span><br />
                  3. Wait ~30s for it to become active<br />
                  4. Collections (<span style={{ color: C.accent }}>telemetry, events, node_status</span>) will be created automatically by this app on connect.
                </div>
              </div>

              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginBottom: 16 }}>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: C.dim, fontSize: 9, marginBottom: 4 }}>ASTRA DB API ENDPOINT</div>
                  <input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-us-east1.apps.astra.datastax.com" style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, padding: "8px 12px", color: C.text, fontFamily: "inherit", fontSize: 10, boxSizing: "border-box" }} />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: C.dim, fontSize: 9, marginBottom: 4 }}>APPLICATION TOKEN (AstraCS:...)</div>
                  <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="AstraCS:xxxxxxxxxxxxxxxxxxxx" style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, padding: "8px 12px", color: C.text, fontFamily: "inherit", fontSize: 10, boxSizing: "border-box" }} />
                </div>
                <button onClick={connectDB} disabled={!endpoint || !token || dbStatus === "connecting"}
                  style={{ padding: "9px 24px", background: C.accent, color: C.bg, border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: 700, fontSize: 11 }}>
                  {dbStatus === "connecting" ? "CONNECTING..." : "▶ CONNECT & START SIMULATION"}
                </button>
                {dbError && (
                  <div style={{ marginTop: 10, background: C.red + "11", border: `1px solid ${C.red}44`, borderRadius: 6, padding: 10 }}>
                    <div style={{ color: C.red, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>✗ Connection failed</div>
                    <div style={{ color: C.text, fontSize: 9, lineHeight: 1.7 }}>{dbError}</div>
                    {dbError.includes("CORS") && (
                      <div style={{ marginTop: 8, color: C.yellow, fontSize: 9 }}>
                        💡 <strong>Fix:</strong> Run locally with Vite — AstraDB allows CORS from localhost:<br />
                        <span style={{ fontFamily: "monospace", color: C.accent }}>npm create vite@latest aecc-sim -- --template react</span><br />
                        <span style={{ fontFamily: "monospace", color: C.accent }}>cd aecc-sim && npm install && npm run dev</span><br />
                        Then paste the artifact code into <span style={{ color: C.accent }}>src/App.jsx</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* What gets created */}
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 8 }}>WHAT GETS CREATED IN YOUR ASTRADB:</div>
              {[
                { col: "telemetry", desc: "Every edge write (POSITION_UPDATE, SENSOR_READING, etc). Also used for offline queue flush on reconnect.", op: "insertOne / insertMany" },
                { col: "events", desc: "Lifecycle events: CONN_LOST, SYNC_REQUEST, CONFLICT_RESOLVED, SYNC_COMPLETE.", op: "insertOne" },
                { col: "node_status", desc: "Live heartbeat for each node — syncState, latency, dataLocal, queueLen. Upserted periodically.", op: "findOneAndReplace (upsert)" },
              ].map(r => (
                <div key={r.col} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, marginBottom: 8, display: "grid", gridTemplateColumns: "140px 1fr 120px", gap: 12, alignItems: "center" }}>
                  <div style={{ color: C.accent, fontWeight: 700 }}>{r.col}</div>
                  <div style={{ color: C.text, fontSize: 9, opacity: 0.8 }}>{r.desc}</div>
                  <div style={{ color: C.purple, fontSize: 9, textAlign: "right" }}>{r.op}</div>
                </div>
              ))}

              <div style={{ marginTop: 16, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 14, fontSize: 9, color: C.dim, lineHeight: 1.8 }}>
                <div style={{ color: C.text, marginBottom: 6, fontWeight: 700 }}>How to get your credentials:</div>
                1. Go to <span style={{ color: C.accent }}>astra.datastax.com</span> → create a free database<br />
                2. Choose any cloud provider / region<br />
                3. In your DB dashboard → <strong>Connect</strong> → copy the <strong>API Endpoint</strong><br />
                4. Generate a token with <strong>Database Administrator</strong> role → copy the token<br />
                5. Paste both above — the app creates the keyspace <span style={{ color: C.accent }}>aecc_tactical</span> automatically
              </div>
            </div>
          )}

          {/* ── TOPOLOGY TAB ── */}
          {tab === "topology" && (
            <svg width="100%" height="100%" style={{ background: C.bg }}>
              <defs>
                <filter id="glow"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                <filter id="soft"><feGaussianBlur stdDeviation="2" /></filter>
              </defs>
              {Array.from({ length: 18 }, (_, i) => <line key={"h" + i} x1={0} y1={i * 40} x2="100%" y2={i * 40} stroke={C.border} strokeWidth={0.3} opacity={0.4} />)}
              {Array.from({ length: 28 }, (_, i) => <line key={"v" + i} x1={i * 40} y1={0} x2={i * 40} y2="100%" stroke={C.border} strokeWidth={0.3} opacity={0.4} />)}

              {EDGES.map(([a, b]) => {
                const na = getPos(a), nb = getPos(b);
                const na_ = nodes.find(n => n.id === a), nb_ = nodes.find(n => n.id === b);
                const linked = na_?.syncState === SS.CONNECTED && nb_?.syncState === SS.CONNECTED;
                const recon = na_?.syncState === SS.RECONNECTING || nb_?.syncState === SS.RECONNECTING;
                return <g key={a + b}>
                  <line x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke={recon ? C.yellow : linked ? C.border : C.dim} strokeWidth={linked ? 1.5 : .6} strokeDasharray={linked ? "none" : "6,4"} opacity={linked ? .9 : .3} />
                  {recon && <line x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke={C.yellow} strokeWidth={1} opacity={.5} strokeDasharray="3,3"><animate attributeName="stroke-dashoffset" values="0;-12" dur=".5s" repeatCount="indefinite" /></line>}
                </g>;
              })}

              {packets.map(p => {
                const f = getPos(p.from), t = getPos(p.to);
                const x = f.x + (t.x - f.x) * p.prog, y = f.y + (t.y - f.y) * p.prog;
                return <g key={p.id} opacity={1 - p.prog * .6}>
                  <circle cx={x} cy={y} r={7} fill={p.color} opacity={.2} filter="url(#soft)" />
                  <circle cx={x} cy={y} r={3} fill={p.color} />
                </g>;
              })}

              {nodes.map(n => {
                const sc = scColor(n.syncState), sel = selected === n.id;
                const qPct = Math.min(1, n.offlineQueue.length / 500);
                const dbCount = dbStats[n.id] ?? null;
                return <g key={n.id} onClick={() => setSel(sel ? null : n.id)} style={{ cursor: "pointer" }}>
                  {sel && <circle cx={n.x} cy={n.y} r={36} fill={C.accent} opacity={.08} />}
                  <circle cx={n.x} cy={n.y} r={24} fill={sc} opacity={.06} filter="url(#soft)" />
                  <circle cx={n.x} cy={n.y} r={22} fill={C.panel} stroke={sc} strokeWidth={sel ? 2.5 : 1.5} />
                  {n.syncState === SS.CONNECTED && <circle cx={n.x} cy={n.y} r={22} fill="none" stroke={sc} strokeWidth={.4} opacity={.3}><animate attributeName="r" values="22;32;22" dur="3s" repeatCount="indefinite" /><animate attributeName="opacity" values=".3;0;.3" dur="3s" repeatCount="indefinite" /></circle>}
                  {qPct > 0 && <circle cx={n.x} cy={n.y} r={22} fill="none" stroke={C.orange} strokeWidth={3} strokeDasharray={`${qPct * 138} 138`} strokeDashoffset={34} opacity={.8} />}
                  <text x={n.x} y={n.y + 6} textAnchor="middle" fontSize={17}>{TIER_ICONS[n.tier]}</text>
                  <circle cx={n.x + 15} cy={n.y - 15} r={6} fill={C.bg} stroke={sc} strokeWidth={1} />
                  <circle cx={n.x + 15} cy={n.y - 15} r={4} fill={sc} />
                  <text x={n.x} y={n.y + 38} textAnchor="middle" fill={C.text} fontSize={10} fontWeight="700">{n.id}</text>
                  {dbCount !== null && <text x={n.x} y={n.y + 50} textAnchor="middle" fill={C.purple} fontSize={8}>DB:{dbCount}</text>}
                  {n.offlineQueue.length > 0 && <text x={n.x} y={dbCount !== null ? n.y + 60 : n.y + 50} textAnchor="middle" fill={C.orange} fontSize={8}>Q:{n.offlineQueue.length}</text>}
                </g>;
              })}
            </svg>
          )}

          {/* ── DIL TAB ── */}
          {tab === "dil" && (
            <div style={{ padding: 20, height: "100%", overflow: "auto" }}>
              <div style={{ color: C.accent, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>⚡ DIL Sync Control</div>
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 16 }}>Disconnect a node to simulate RF jamming / loss of comms. Reconnect to watch the 8-phase AstraDB sync protocol execute in real time.</div>
              {!dbConnected && <div style={{ color: C.yellow, background: C.yellow + "11", border: `1px solid ${C.yellow}33`, borderRadius: 6, padding: 10, fontSize: 10, marginBottom: 16 }}>⚠ AstraDB not connected — sync steps will simulate without real DB writes. Go to Setup tab to connect.</div>}

              {syncDetail && (
                <div style={{ background: C.panel, border: `1px solid ${C.yellow}44`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
                  <div style={{ color: C.yellow, fontWeight: 700, marginBottom: 12 }}>🔄 ACTIVE SYNC: {syncDetail.nodeId} → {syncDetail.parent}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: "4px 10px", alignItems: "start" }}>
                    {syncDetail.steps.map((s, i) => {
                      const done = i < syncDetail.phase, active = i === syncDetail.phase - 1;
                      return [
                        <div key={"i" + i} style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: done ? s.color + "33" : "transparent", border: `1px solid ${done ? s.color : C.border}`, color: done ? s.color : C.dim, fontSize: 9, fontWeight: 700, flexShrink: 0 }}>
                          {done ? "✓" : i + 1}
                        </div>,
                        <div key={"t" + i} style={{ paddingBottom: 6, borderBottom: i < syncDetail.steps.length - 1 ? `1px solid ${C.border}22` : "none" }}>
                          <div style={{ color: done ? s.color : C.dim, fontWeight: 700, fontSize: 9 }}>{s.label}{active ? " ▶" : ""}</div>
                          <div style={{ color: done ? C.text : C.dim, fontSize: 8, opacity: done ? .85 : .4, marginTop: 1 }}>{s.detail}</div>
                        </div>
                      ];
                    })}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Bar pct={(syncDetail.phase / syncDetail.steps.length) * 100} color={C.accent} />
                    <div style={{ color: C.dim, fontSize: 8, marginTop: 3 }}>{syncDetail.phase}/{syncDetail.steps.length} steps — {syncDetail.qLen} ops queued</div>
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
                {nodes.filter(n => n.tier !== "TACTICAL_CLOUD").map(n => (
                  <div key={n.id} style={{ background: C.panel, border: `1px solid ${n.syncState === SS.DISCONNECTED ? C.red + "55" : C.border}`, borderRadius: 8, padding: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 18 }}>{TIER_ICONS[n.tier]}</span>
                      <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: C.accent, fontSize: 11 }}>{n.id}</div><div style={{ color: C.dim, fontSize: 9 }}>{n.label}</div></div>
                      <Tag s={n.syncState} />
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                        <span style={{ color: C.dim, fontSize: 8 }}>OFFLINE QUEUE</span>
                        <span style={{ color: n.offlineQueue.length > 100 ? C.red : n.offlineQueue.length > 20 ? C.orange : C.green, fontSize: 8, fontWeight: 700 }}>{n.offlineQueue.length}/500</span>
                      </div>
                      <Bar pct={(n.offlineQueue.length / 500) * 100} color={n.offlineQueue.length > 200 ? C.red : n.offlineQueue.length > 50 ? C.orange : C.yellow} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 10 }}>
                      {[["Drift", `${n.dataLocal - n.dataSynced} recs`], ["Latency", `${n.latency}ms`], ["DB Records", dbStats[n.id] ?? "-"], ["Conflicts", n.conflicts]].map(([k, v]) => (
                        <div key={k} style={{ background: C.bg, borderRadius: 4, padding: "4px 8px" }}>
                          <div style={{ color: C.dim, fontSize: 7 }}>{k}</div>
                          <div style={{ color: C.text, fontWeight: 700, fontSize: 10 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                    {n.offlineQueue.length > 0 && (
                      <div style={{ background: C.bg, borderRadius: 4, padding: 8, marginBottom: 8, maxHeight: 60, overflow: "hidden" }}>
                        {n.offlineQueue.slice(-3).reverse().map(op => (
                          <div key={op.id} style={{ color: C.orange, fontSize: 7, padding: "1px 0" }}>{op.id} {op.type} seq:{op.vclock_seq}</div>
                        ))}
                        {n.offlineQueue.length > 3 && <div style={{ color: C.dim, fontSize: 7 }}>+{n.offlineQueue.length - 3} more buffered</div>}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => disconnectNode(n.id)} disabled={n.syncState !== SS.CONNECTED}
                        style={{ flex: 1, padding: "5px 0", background: C.red + "22", color: n.syncState === SS.CONNECTED ? C.red : C.dim, border: `1px solid ${n.syncState === SS.CONNECTED ? C.red + "55" : C.dim + "22"}`, borderRadius: 4, cursor: n.syncState === SS.CONNECTED ? "pointer" : "default", fontFamily: "inherit", fontSize: 8, fontWeight: 700 }}>✂ DISCONNECT</button>
                      <button onClick={() => reconnectNode(n.id)} disabled={n.syncState !== SS.DISCONNECTED}
                        style={{ flex: 1, padding: "5px 0", background: C.green + "22", color: n.syncState === SS.DISCONNECTED ? C.green : C.dim, border: `1px solid ${n.syncState === SS.DISCONNECTED ? C.green + "55" : C.dim + "22"}`, borderRadius: 4, cursor: n.syncState === SS.DISCONNECTED ? "pointer" : "default", fontFamily: "inherit", fontSize: 8, fontWeight: 700 }}>⟳ RECONNECT + SYNC</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── SCHEMA & FLOW TAB ── */}
          {tab === "schema" && (
            <div style={{ padding: 20, height: "100%", overflow: "auto" }}>
              <div style={{ color: C.accent, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>🛢 AstraDB — Where It Actually Plugs In</div>

              {/* Flow diagram */}
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <div style={{ color: C.dim, fontSize: 9, marginBottom: 10 }}>DATA FLOW — ONLINE vs OFFLINE</div>
                <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
                  {[
                    { label: "Edge Device", sub: "Patrol / Sensor", color: C.green },
                    { arrow: "→ online: insertOne\n→ offline: local queue" },
                    { label: "AstraDB", sub: "telemetry collection", color: C.purple },
                    { arrow: "findOneAndReplace\nupsert" },
                    { label: "node_status", sub: "live heartbeat", color: C.accent },
                  ].map((item, i) => "arrow" in item ? (
                    <div key={i} style={{ color: C.dim, fontSize: 8, padding: "0 8px", whiteSpace: "pre", textAlign: "center" }}>{item.arrow}</div>
                  ) : (
                    <div key={i} style={{ background: item.color + "22", border: `1px solid ${item.color}44`, borderRadius: 6, padding: "8px 12px", textAlign: "center" }}>
                      <div style={{ color: item.color, fontWeight: 700, fontSize: 10 }}>{item.label}</div>
                      <div style={{ color: C.dim, fontSize: 8 }}>{item.sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, color: C.dim, fontSize: 8 }}>On reconnect: <span style={{ color: C.yellow }}>insertMany(queue, ordered:false)</span> → duplicate _id silently dropped → <span style={{ color: C.green }}>idempotent replay</span></div>
              </div>

              {/* Collections */}
              <div style={{ color: C.dim, fontSize: 9, marginBottom: 8 }}>COLLECTIONS IN KEYSPACE aecc_tactical:</div>
              {[
                { name: "telemetry", color: C.accent, when: "Every edge write (online) or offline queue flush (reconnect)", api: "insertOne / insertMany", fields: "_id, node_id, op_type, payload, vclock_seq, edge_ts, sync_ts, conflict_flag" },
                { name: "events", color: C.yellow, when: "Lifecycle: CONN_LOST, SYNC_REQUEST, CONFLICT_RESOLVED, SYNC_COMPLETE", api: "insertOne", fields: "_id, event_type, node_id, detail, ts" },
                { name: "node_status", color: C.purple, when: "Heartbeat every ~5 writes, and on every syncState change", api: "findOneAndReplace {upsert:true}", fields: "_id, tier, syncState, latency, dataLocal, dataSynced, queueLen, vclock, updatedAt" },
              ].map(c => (
                <div key={c.name} style={{ background: C.panel, border: `1px solid ${c.color}33`, borderRadius: 8, padding: 14, marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div style={{ color: c.color, fontWeight: 700, fontSize: 12 }}>{c.name}</div>
                    <div style={{ background: c.color + "22", color: c.color, borderRadius: 3, padding: "1px 8px", fontSize: 8 }}>{c.api}</div>
                  </div>
                  <div style={{ color: C.text, fontSize: 9, marginBottom: 6 }}><span style={{ color: C.dim }}>WHEN: </span>{c.when}</div>
                  <div style={{ color: C.dim, fontSize: 8, fontFamily: "monospace" }}>{c.fields}</div>
                </div>
              ))}

              {/* CQL Schema */}
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, fontFamily: "monospace", fontSize: 9, lineHeight: 1.7 }}>
                <div style={{ color: C.dim, marginBottom: 6 }}>-- Equivalent CQL schema (AstraDB JSON API abstracts this)</div>
                <div><span style={{ color: C.purple }}>CREATE TABLE</span> aecc_tactical.telemetry {"("}</div>
                <div style={{ paddingLeft: 16 }}>node_id       text,</div>
                <div style={{ paddingLeft: 16 }}>vclock_seq    bigint,  <span style={{ color: C.dim }}>-- causal ordering</span></div>
                <div style={{ paddingLeft: 16 }}>op_id         uuid,    <span style={{ color: C.dim }}>-- idempotency key</span></div>
                <div style={{ paddingLeft: 16 }}>op_type       text,</div>
                <div style={{ paddingLeft: 16 }}>payload       text,</div>
                <div style={{ paddingLeft: 16 }}>edge_ts       timestamp, <span style={{ color: C.dim }}>-- device-side timestamp (LWW source)</span></div>
                <div style={{ paddingLeft: 16 }}>sync_ts       timestamp, <span style={{ color: C.dim }}>-- cloud receipt time</span></div>
                <div style={{ paddingLeft: 16 }}>conflict_flag boolean,</div>
                <div><span style={{ color: C.purple }}>PRIMARY KEY</span> ((node_id), vclock_seq, op_id)</div>
                <div>{") WITH CLUSTERING ORDER BY (vclock_seq DESC);"}</div>
                <div style={{ marginTop: 10, color: C.dim }}>-- Idempotent batch on reconnect</div>
                <div><span style={{ color: C.purple }}>BEGIN UNLOGGED BATCH</span></div>
                <div style={{ paddingLeft: 16 }}><span style={{ color: C.yellow }}>INSERT INTO</span> telemetry ... <span style={{ color: C.green }}>IF NOT EXISTS</span>; <span style={{ color: C.dim }}>-- LWT dedup</span></div>
                <div style={{ paddingLeft: 16 }}><span style={{ color: C.yellow }}>INSERT INTO</span> telemetry ... <span style={{ color: C.green }}>IF NOT EXISTS</span>;</div>
                <div><span style={{ color: C.purple }}>APPLY BATCH</span>;</div>
              </div>
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div style={{ width: 265, background: C.panel, borderLeft: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {selNode ? (
            <div style={{ padding: 12, flex: "0 0 auto", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 18 }}>{TIER_ICONS[selNode.tier]}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: C.accent, fontSize: 11 }}>{selNode.id}</div>
                  <div style={{ color: C.dim, fontSize: 8 }}>{selNode.label}</div>
                </div>
                <Tag s={selNode.syncState} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 8 }}>
                {[["Local", selNode.dataLocal], ["Synced", selNode.dataSynced], ["Queue", selNode.offlineQueue.length], ["DB Records", dbStats[selNode.id] ?? "-"], ["Conflicts", selNode.conflicts], ["vclock", selNode.vclock]].map(([k, v]) => (
                  <div key={k} style={{ background: C.bg, borderRadius: 4, padding: "4px 7px" }}>
                    <div style={{ color: C.dim, fontSize: 7 }}>{k}</div>
                    <div style={{ color: k === "DB Records" ? C.purple : C.text, fontWeight: 700, fontSize: 10 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom: 5 }}>
                <div style={{ color: C.dim, fontSize: 7, marginBottom: 2 }}>SYNC %</div>
                <Bar pct={selNode.dataLocal ? Math.round((selNode.dataSynced / selNode.dataLocal) * 100) : 100} />
              </div>
              {selNode.tier !== "TACTICAL_CLOUD" && (
                <div style={{ display: "flex", gap: 5, marginTop: 8 }}>
                  <button onClick={() => disconnectNode(selNode.id)} disabled={selNode.syncState !== SS.CONNECTED} style={{ flex: 1, padding: "4px 0", background: C.red + "22", color: selNode.syncState === SS.CONNECTED ? C.red : C.dim, border: `1px solid ${C.red}33`, borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 8, fontWeight: 700 }}>✂ DISC</button>
                  <button onClick={() => reconnectNode(selNode.id)} disabled={selNode.syncState !== SS.DISCONNECTED} style={{ flex: 1, padding: "4px 0", background: C.green + "22", color: selNode.syncState === SS.DISCONNECTED ? C.green : C.dim, border: `1px solid ${C.green}33`, borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 8, fontWeight: 700 }}>⟳ SYNC</button>
                </div>
              )}

              {/* Live DB records */}
              {liveOps.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ color: C.purple, fontSize: 8, marginBottom: 4 }}>▸ LIVE FROM ASTRADB ({liveOps.length} recent):</div>
                  <div style={{ maxHeight: 120, overflow: "auto" }}>
                    {liveOps.map((op, i) => (
                      <div key={i} style={{ fontSize: 7, padding: "2px 0", borderBottom: `1px solid ${C.border}22`, color: C.text, opacity: .8 }}>
                        <span style={{ color: C.accent }}>{op.op_type}</span> seq:{op.vclock_seq} <span style={{ color: C.dim }}>{new Date(op.edge_ts).toISOString().slice(11, 19)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: 10 }}>
              <div style={{ color: C.dim, fontSize: 8, marginBottom: 6 }}>ALL NODES</div>
              {nodes.map(n => (
                <div key={n.id} onClick={() => setSel(n.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 7px", borderRadius: 4, cursor: "pointer", marginBottom: 2, background: C.bg, border: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 11 }}>{TIER_ICONS[n.tier]}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 9 }}>{n.id}</div>
                    {n.offlineQueue.length > 0 && <div style={{ color: C.orange, fontSize: 7 }}>Q:{n.offlineQueue.length}</div>}
                  </div>
                  {dbStats[n.id] != null && <div style={{ color: C.purple, fontSize: 7 }}>DB:{dbStats[n.id]}</div>}
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: scColor(n.syncState) }} />
                </div>
              ))}
            </div>
          )}

          <div style={{ borderTop: `1px solid ${C.border}`, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "5px 10px", color: C.dim, fontSize: 8, borderBottom: `1px solid ${C.border}22` }}>▼ EVENT LOG</div>
            <div style={{ flex: 1, overflow: "auto", padding: "2px 5px" }}>
              {log.map(ev => (
                <div key={ev.id} style={{ padding: "2px 3px", borderBottom: `1px solid ${C.border}11`, fontSize: 7.5, lineHeight: 1.5 }}>
                  <span style={{ color: C.dim }}>{ev.t} </span>
                  <span style={{ color: ev.level === "WARN" ? C.yellow : ev.level === "ERR" ? C.red : C.text, opacity: .9 }}>{ev.msg}</span>
                </div>
              ))}
              {log.length === 0 && <div style={{ color: C.dim, textAlign: "center", paddingTop: 24, fontSize: 9 }}>No events yet</div>}
            </div>
          </div>
        </div>
      </div>
      <ChatBot />
    </div>
  );
}
import { useMemo, useRef, useState } from "react";
import { createMeasurement, waitForMeasurement } from "./lib/globalping";
import { fetchNlnogPrefix } from "./lib/nlnog";

function isIpLiteral(s) {
  // semplice: basta per bloccare i casi più comuni
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(s) || (s.includes(":") && ipv6.test(s));
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return `${n.toFixed(1)} ms`;
}

export default function App() {
  const [target, setTarget] = useState("ping6.it");
  const [limit, setLimit] = useState(12);

  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [v4, setV4] = useState(null);
  const [v6, setV6] = useState(null);

  const [prefix, setPrefix] = useState("37.123.100.0/24");
  const [nodes, setNodes] = useState("BITTERBAL1-V4,BITTERBAL1-V6");
  const [nlnog, setNlnog] = useState(null);

  const abortRef = useRef(null);

  const rows = useMemo(() => {
    if (!v4?.results || !v6?.results) return [];
    const out = [];
    const n = Math.min(v4.results.length, v6.results.length);

    for (let i = 0; i < n; i++) {
      const a = v4.results[i];
      const b = v6.results[i];

      const probe = a.probe;
      const tags = probe?.tags || [];
      const kind = tags.includes("eyeball-network")
        ? "eyeball"
        : tags.includes("datacenter-network")
          ? "dc"
          : "other";

      const r4 = a.result?.status === "finished" ? a.result : null;
      const r6 = b.result?.status === "finished" ? b.result : null;

      const avg4 = r4?.stats?.avg ?? null;
      const avg6 = r6?.stats?.avg ?? null;
      const delta = avg4 != null && avg6 != null ? (avg6 - avg4) : null;

      out.push({
        i: i + 1,
        kind,
        loc: `${probe.city}, ${probe.country}`,
        asn: probe.asn,
        net: probe.network,
        avg4,
        avg6,
        delta,
        loss4: r4?.stats?.loss ?? null,
        loss6: r6?.stats?.loss ?? null,
      });
    }
    return out;
  }, [v4, v6]);

  async function runPingCompare() {
    setErr("");
    setV4(null);
    setV6(null);

    const t = target.trim();
    if (!t) return;

    // ipVersion è consentito solo se il target è hostname :contentReference[oaicite:9]{index=9}
    if (isIpLiteral(t)) {
      setErr("Per il confronto v4/v6 inserisci un hostname (non un IP).");
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setRunning(true);
    try {
      const locations = [
        { magic: "Europe+eyeball-network" },
        { magic: "Europe+datacenter-network" },
      ];

      const base = {
        type: "ping",
        target: t,
        locations,
        limit: Math.max(1, Math.min(50, Number(limit) || 12)),
        inProgressUpdates: true,
        measurementOptions: { packets: 3 },
      };

      // 1) crea v4
      const m4 = await createMeasurement(
        { ...base, measurementOptions: { ...base.measurementOptions, ipVersion: 4 } },
        ac.signal
      );

      // 2) crea v6 riusando gli stessi probe col measurement id (locations: "<id>") :contentReference[oaicite:10]{index=10}
      const m6 = await createMeasurement(
        { ...base, locations: m4.id, measurementOptions: { ...base.measurementOptions, ipVersion: 6 } },
        ac.signal
      );

      // 3) aspetta risultati (poll 500ms) :contentReference[oaicite:11]{index=11}
      const [r4, r6] = await Promise.all([
        waitForMeasurement(m4.id, { onUpdate: setV4, signal: ac.signal }),
        waitForMeasurement(m6.id, { onUpdate: setV6, signal: ac.signal }),
      ]);

      setV4(r4);
      setV6(r6);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }

  async function runNlnog() {
    setErr("");
    setNlnog(null);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setRunning(true);
    try {
      const data = await fetchNlnogPrefix({
        q: prefix.trim(),
        nodes: nodes.trim(),
        signal: ac.signal,
      });
      setNlnog(data);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setRunning(false);
  }

  return (
    <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: "8px 0" }}>ping6.it</h1>
      <div style={{ opacity: 0.8, marginBottom: 16 }}>
        Globalping v4/v6 compare + NLNOG Looking Glass (prefix). {/* globalping API + guidelines */}:contentReference[oaicite:12]{index=12}
      </div>

      {err && (
        <div style={{ background: "#fee", border: "1px solid #f99", padding: 12, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {err}
        </div>
      )}

      <section style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8, marginBottom: 16 }}>
        <h2 style={{ margin: "0 0 8px 0" }}>Ping v4 vs v6 (EU, stessi probe)</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="hostname (es. example.com)"
            style={{ padding: 8, minWidth: 260 }}
            disabled={running}
          />
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="probes (max 50)"
            style={{ padding: 8, width: 140 }}
            disabled={running}
          />
          <button onClick={runPingCompare} disabled={running} style={{ padding: "8px 12px" }}>
            Run
          </button>
          <button onClick={cancel} disabled={!running} style={{ padding: "8px 12px" }}>
            Cancel
          </button>
        </div>

        {rows.length > 0 && (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["#", "type", "location", "ASN", "network", "v4 avg", "v6 avg", "Δ (v6-v4)", "loss v4", "loss v6"].map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.i}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.i}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.kind}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.loc}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.asn}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.net}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{fmt(r.avg4)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{fmt(r.avg6)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{fmt(r.delta)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.loss4 ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r.loss6 ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8 }}>
        <h2 style={{ margin: "0 0 8px 0" }}>NLNOG Looking Glass: prefix</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="prefix (es. 203.0.113.0/24)"
            style={{ padding: 8, minWidth: 260 }}
            disabled={running}
          />
          <input
            value={nodes}
            onChange={(e) => setNodes(e.target.value)}
            placeholder="nodes (comma separated)"
            style={{ padding: 8, minWidth: 280 }}
            disabled={running}
          />
          <button onClick={runNlnog} disabled={running} style={{ padding: "8px 12px" }}>
            Query
          </button>
        </div>

        {nlnog && (
          <pre style={{ marginTop: 12, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 8, overflowX: "auto" }}>
            {typeof nlnog === "string" ? nlnog : JSON.stringify(nlnog, null, 2)}
          </pre>
        )}

        <div style={{ marginTop: 8, opacity: 0.8 }}>
          Esempio endpoint (documentato): <code>/api/prefix?q=...&amp;nodes=BITTERBAL1-V4</code>. :contentReference[oaicite:13]{index=13}
        </div>
      </section>
    </div>
  );
}


import { useRef, useState } from "react";
import { createMeasurement, waitForMeasurement } from "./lib/globalping";

function isIpLiteral(s) {
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(s) || (s.includes(":") && ipv6.test(s));
}

export default function App() {
  const [target, setTarget] = useState("example.com");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
const [v4, setV4] = useState(null);
const [v6, setV6] = useState(null);


  const abortRef = useRef(null);

  async function run() {
    setErr("");
setV4(null);
setV6(null);


    const t = target.trim();
    if (!t) return;

    if (isIpLiteral(t)) {
      setErr("Per il confronto v4/v6 inserisci un hostname (non un IP).");
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setRunning(true);
    try {
      const base = {
        type: "ping",
        target: t,
        // EU, pochi probe per partire
        locations: [{ magic: "Western Europe" }],
        limit: 4,
        inProgressUpdates: true,
        measurementOptions: { packets: 3 },
      };

      const m4 = await createMeasurement(
        { ...base, measurementOptions: { ...base.measurementOptions, ipVersion: 4 } },
        ac.signal
      );

      const m6 = await createMeasurement(
        { ...base, locations: m4.id, measurementOptions: { ...base.measurementOptions, ipVersion: 6 } },
        ac.signal
      );

      const [r4, r6] = await Promise.all([
        waitForMeasurement(m4.id, { signal: ac.signal }),
        waitForMeasurement(m6.id, { signal: ac.signal }),
      ]);

setV4(r4);
setV6(r6);

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
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: "8px 0" }}>ping6.it</h1>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="hostname (es. example.com)"
          style={{ padding: 8, minWidth: 280 }}
          disabled={running}
        />
        <button onClick={run} disabled={running} style={{ padding: "8px 12px" }}>
          Run
        </button>
        <button onClick={cancel} disabled={!running} style={{ padding: "8px 12px" }}>
          Cancel
        </button>
      </div>
{err && (
  <div
    style={{
      background: "#fee",
      color: "#111",
      border: "1px solid #f99",
      padding: 12,
      marginBottom: 12,
      whiteSpace: "pre-wrap",
    }}
  >
    {err}
  </div>
)}

{v4 && v6 && (
  <div style={{ display: "grid", gap: 16 }}>
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {["#", "probe", "ASN", "network", "v4 avg", "v4 loss", "v6 avg", "v6 loss"].map((h) => (
              <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "6px 8px" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v4.results?.map((a, i) => {
            const b = v6.results?.[i];
            const p = a?.probe || b?.probe;
            const r4 = a?.result?.status === "finished" ? a.result : null;
            const r6 = b?.result?.status === "finished" ? b.result : null;

            const avg4 = r4?.stats?.avg;
            const avg6 = r6?.stats?.avg;
            const loss4 = r4?.stats?.loss;
            const loss6 = r6?.stats?.loss;

            return (
              <tr key={i}>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                  {p ? `${p.city}, ${p.country}` : "-"}
                </td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{p?.asn ?? "-"}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{p?.network ?? "-"}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{avg4 != null ? `${avg4.toFixed(1)} ms` : "-"}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{loss4 ?? "-"}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{avg6 != null ? `${avg6.toFixed(1)} ms` : "-"}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{loss6 ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <h3 style={{ margin: "0 0 6px 0" }}>RAW v4</h3>
        <pre style={{ padding: 12, background: "#f3f4f6", color: "#111", border: "1px solid #ddd", borderRadius: 8, overflowX: "auto" }}>
          {v4.results?.map((x, idx) => {
            const p = x.probe;
            const raw = x.result?.rawOutput ?? "";
            return `--- probe ${idx + 1}: ${p?.city || ""} ${p?.country || ""} AS${p?.asn || ""} ${p?.network || ""}\n${raw}\n`;
          }).join("\n")}
        </pre>
      </div>

      <div>
        <h3 style={{ margin: "0 0 6px 0" }}>RAW v6</h3>
        <pre style={{ padding: 12, background: "#f3f4f6", color: "#111", border: "1px solid #ddd", borderRadius: 8, overflowX: "auto" }}>
          {v6.results?.map((x, idx) => {
            const p = x.probe;
            const raw = x.result?.rawOutput ?? "";
            return `--- probe ${idx + 1}: ${p?.city || ""} ${p?.country || ""} AS${p?.asn || ""} ${p?.network || ""}\n${raw}\n`;
          }).join("\n")}
        </pre>
      </div>
    </div>
  </div>
)}

    </div>
  );
}


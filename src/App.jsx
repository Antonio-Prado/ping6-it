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
  const [out, setOut] = useState("");

  const abortRef = useRef(null);

  async function run() {
    setErr("");
    setOut("");

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

      setOut(JSON.stringify({ v4: r4, v6: r6 }, null, 2));
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

{out && (
  <pre
    style={{
      padding: 12,
      background: "#f3f4f6",
      color: "#111",
      border: "1px solid #ddd",
      borderRadius: 8,
      overflowX: "auto",
      whiteSpace: "pre-wrap",
    }}
  >
    {out}
  </pre>
)}

    </div>
  );
}


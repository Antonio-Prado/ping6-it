import { useRef, useState } from "react";
import { createMeasurement, waitForMeasurement } from "./lib/globalping";
import { fetchNlnogPrefix } from "./lib/nlnog";

function isIpLiteral(s) {
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  return ipv4.test(s) || (s.includes(":") && ipv6.test(s));
}

function ms(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return `${n.toFixed(1)} ms`;
}

function probeHeader(x, idx) {
  const p = x?.probe || {};
  return `--- probe ${idx + 1}: ${p.city || ""} ${p.country || ""} AS${p.asn || ""} ${p.network || ""}`.trim();
}

// Applica tag Globalping (eyeball/datacenter) a una stringa "from" anche se contiene più location separate da virgola.
// Esempi: "Western Europe" + eyeball => "Western Europe+eyeball"
//         "Berlin,Paris" + datacenter => "Berlin+datacenter,Paris+datacenter"
//         "eyeball" (da solo) resta "eyeball"
function applyGpTag(fromStr, tag) {
  const t = (tag || "").trim();
  if (!t || t === "any") return (fromStr || "").trim();

  const raw = (fromStr || "").trim();
  if (!raw) return t; // se non specifichi location, puoi usare direttamente "eyeball"/"datacenter" 

  // Se l'utente ha già messo il tag a mano, non duplicare
  if (raw.includes(`+${t}`) || raw === t) return raw;

  // Multi-location: "A,B,C"
  return raw
    .split(",")
    .map((p) => {
      const s = p.trim();
      if (!s) return s;
      if (s.includes(`+${t}`) || s === t) return s;
      // evita doppio tag se contiene già l'altro
      if (t === "eyeball" && (s.includes("+datacenter") || s === "datacenter")) return s;
      if (t === "datacenter" && (s.includes("+eyeball") || s === "eyeball")) return s;
      return `${s}+${t}`;
    })
    .join(", ");
}

export default function App() {
  // Globalping UI
  const [target, setTarget] = useState("example.com");
  const [cmd, setCmd] = useState("ping"); // ping | traceroute
  const [from, setFrom] = useState("Western Europe");
  const [gpTag, setGpTag] = useState("any"); // any | eyeball | datacenter
  const [limit, setLimit] = useState(3);

  const [packets, setPackets] = useState(3); // ping only
  const [trProto, setTrProto] = useState("ICMP"); // traceroute: ICMP | TCP | UDP
  const [trPort, setTrPort] = useState(80); // traceroute TCP only

  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [v4, setV4] = useState(null);
  const [v6, setV6] = useState(null);

  const abortRef = useRef(null);

  // NLNOG UI
  const [nlnogQ, setNlnogQ] = useState("193.0.14.0/23");
  const [nlnogNodes, setNlnogNodes] = useState("BITTERBAL1-V4,BITTERBAL1-V6");
  const [nlnogRunning, setNlnogRunning] = useState(false);
  const [nlnogErr, setNlnogErr] = useState("");
  const [nlnogOut, setNlnogOut] = useState("");

  async function run() {
    setErr("");
    setV4(null);
    setV6(null);

    const t = target.trim();
    if (!t) return;

    // Compare v4/v6: richiede hostname (non IP literal)
    if (isIpLiteral(t)) {
      setErr("Per il confronto v4/v6 inserisci un hostname (non un IP).");
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setRunning(true);
    try {
      const probes = Math.max(1, Math.min(10, Number(limit) || 3));

      const fromWithTag = applyGpTag(from, gpTag);

      let measurementOptions = {};
      if (cmd === "ping") {
        measurementOptions = { packets: Math.max(1, Math.min(10, Number(packets) || 3)) };
      } else if (cmd === "traceroute") {
        measurementOptions = { protocol: trProto };
        if (trProto === "TCP") {
          measurementOptions.port = Math.max(1, Math.min(65535, Number(trPort) || 80));
        }
      }
	else if (cmd === "mtr") {
  measurementOptions = {
    packets: Math.max(1, Math.min(16, Number(packets) || 3)),
    protocol: trProto,
  };
  if (trProto !== "ICMP") {
    measurementOptions.port = Math.max(1, Math.min(65535, Number(trPort) || 80));
  }
}


      const base = {
        type: cmd,
        target: t,
        locations: [{ magic: fromWithTag || "world" }],
        limit: probes,
        inProgressUpdates: true,
      };

      // v4
      const m4 = await createMeasurement(
        { ...base, measurementOptions: { ...measurementOptions, ipVersion: 4 } },
        ac.signal
      );

      // v6 sugli stessi probe (locations = id v4)
      const m6 = await createMeasurement(
        { ...base, locations: m4.id, measurementOptions: { ...measurementOptions, ipVersion: 6 } },
        ac.signal
      );

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

  function cancel() {
    abortRef.current?.abort();
    setRunning(false);
  }

  async function runNlnog() {
    setNlnogErr("");
    setNlnogOut("");

    const q = nlnogQ.trim();
    const nodes = nlnogNodes.trim();
    if (!q || !nodes) {
      setNlnogErr("Devi specificare sia q (prefix) che nodes.");
      return;
    }

    setNlnogRunning(true);
    try {
      const res = await fetchNlnogPrefix({ q, nodes });
      if (typeof res === "string") setNlnogOut(res);
      else setNlnogOut(JSON.stringify(res, null, 2));
    } catch (e) {
      setNlnogErr(e?.message || String(e));
    } finally {
      setNlnogRunning(false);
    }
  }

  const showPingTable = cmd === "ping" && v4 && v6;

  const preStyle = {
    padding: 12,
    background: "#111827",
    color: "#f9fafb",
    border: "1px solid #111827",
    borderRadius: 8,
    overflowX: "auto",
    lineHeight: 1.35,
  };

  return (
    <div style={{ fontFamily: "ui-monospace, Menlo, monospace", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: "8px 0" }}>ping6.it</h1>

      {/* Globalping controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label>
          Command{" "}
          <select value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={running} style={{ padding: 6 }}>
            <option value="ping">ping</option>
            <option value="traceroute">traceroute</option>
		<option value="mtr">mtr</option>
          </select>
        </label>

        <label>
          Net{" "}
          <select value={gpTag} onChange={(e) => setGpTag(e.target.value)} disabled={running} style={{ padding: 6 }}>
            <option value="any">any</option>
            <option value="eyeball">eyeball</option>
            <option value="datacenter">datacenter</option>
          </select>
        </label>

        <label>
          From{" "}
          <input value={from} onChange={(e) => setFrom(e.target.value)} disabled={running} style={{ padding: 6, width: 220 }} />
        </label>

        <label>
          Probes{" "}
          <input value={limit} onChange={(e) => setLimit(e.target.value)} disabled={running} style={{ padding: 6, width: 70 }} />
        </label>

{(cmd === "ping" || cmd === "mtr") && (
  <label>
    {cmd === "mtr" ? "Packets/hop" : "Packets"}{" "}
    <input value={packets} onChange={(e) => setPackets(e.target.value)} disabled={running} style={{ padding: 6, width: 70 }} />
  </label>
)}
{(cmd === "traceroute" || cmd === "mtr") && (
  <>
    <label>
      Proto{" "}
      <select value={trProto} onChange={(e) => setTrProto(e.target.value)} disabled={running} style={{ padding: 6 }}>
        <option value="ICMP">ICMP</option>
        <option value="UDP">UDP</option>
        <option value="TCP">TCP</option>
      </select>
    </label>

    {((cmd === "traceroute" && trProto === "TCP") || (cmd === "mtr" && trProto !== "ICMP")) && (
      <label>
        Port{" "}
        <input value={trPort} onChange={(e) => setTrPort(e.target.value)} disabled={running} style={{ padding: 6, width: 90 }} />
      </label>
    )}
  </>
)}

        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="hostname (es. example.com)"
          style={{ padding: 8, minWidth: 260 }}
          disabled={running}
        />

        <button onClick={run} disabled={running} style={{ padding: "8px 12px" }}>
          Run
        </button>
        <button onClick={cancel} disabled={!running} style={{ padding: "8px 12px" }}>
          Cancel
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={() => setFrom("Western Europe")} disabled={running} style={{ padding: "6px 10px" }}>
          Western Europe
        </button>
        <button onClick={() => setFrom("Northern Europe")} disabled={running} style={{ padding: "6px 10px" }}>
          Northern Europe
        </button>
        <button onClick={() => setFrom("Southern Europe")} disabled={running} style={{ padding: "6px 10px" }}>
          Southern Europe
        </button>
        <button onClick={() => setFrom("Eastern Europe")} disabled={running} style={{ padding: "6px 10px" }}>
          Eastern Europe
        </button>
        <button onClick={() => setFrom("Europe")} disabled={running} style={{ padding: "6px 10px" }}>
          Europe
        </button>
        <button onClick={() => setFrom("world")} disabled={running} style={{ padding: "6px 10px" }}>
          world
        </button>
      </div>

      {err && (
        <div style={{ background: "#fee", color: "#111", border: "1px solid #f99", padding: 12, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {err}
        </div>
      )}

      {/* Ping summary table */}
      {showPingTable && (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["#", "location", "ASN", "network", "v4 avg", "v4 loss", "v6 avg", "v6 loss"].map((h) => (
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

                return (
                  <tr key={i}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{i + 1}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{p ? `${p.city}, ${p.country}` : "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{p?.asn ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{p?.network ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r4?.stats?.avg)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r4?.stats?.loss ?? "-"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{ms(r6?.stats?.avg)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{r6?.stats?.loss ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* RAW outputs */}
      {v4 && v6 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
          <div>
            <h3 style={{ margin: "0 0 6px 0" }}>RAW v4</h3>
            <pre style={preStyle}>
              {v4.results?.map((x, idx) => `${probeHeader(x, idx)}\n${x.result?.rawOutput ?? ""}\n`).join("\n")}
            </pre>
          </div>

          <div>
            <h3 style={{ margin: "0 0 6px 0" }}>RAW v6</h3>
            <pre style={preStyle}>
              {v6.results?.map((x, idx) => `${probeHeader(x, idx)}\n${x.result?.rawOutput ?? ""}\n`).join("\n")}
            </pre>
          </div>
        </div>
      )}

      {/* NLNOG section */}
      <h2 style={{ margin: "16px 0 8px 0" }}>NLNOG LG (BGP prefix)</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <label>
          q{" "}
          <input value={nlnogQ} onChange={(e) => setNlnogQ(e.target.value)} disabled={nlnogRunning} style={{ padding: 6, width: 220 }} />
        </label>
        <label>
          nodes{" "}
          <input
            value={nlnogNodes}
            onChange={(e) => setNlnogNodes(e.target.value)}
            disabled={nlnogRunning}
            style={{ padding: 6, width: 320 }}
          />
        </label>

        <button onClick={runNlnog} disabled={nlnogRunning} style={{ padding: "8px 12px" }}>
          Query
        </button>

        <button
          onClick={() => setNlnogNodes("BITTERBAL1-V4,BITTERBAL1-V6")}
          disabled={nlnogRunning}
          style={{ padding: "8px 12px" }}
        >
          BIT (v4+v6)
        </button>
      </div>

      {nlnogErr && (
        <div style={{ background: "#fee", color: "#111", border: "1px solid #f99", padding: 12, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {nlnogErr}
        </div>
      )}

      {nlnogOut && <pre style={preStyle}>{nlnogOut}</pre>}

      <div style={{ marginTop: 10, opacity: 0.75 }}>
        Nota: Globalping supporta i tag <code>eyeball</code>/<code>datacenter</code> e li combina alle location con <code>+</code> (anche su <code>world</code> o regioni tipo “Western Europe”). 
      </div>
    </div>
  );
}


import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
} from "chart.js";

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend);

function getAlertStatusWithCountdown(lastTime: string | undefined, resetMinutes: number): string {
  if (!lastTime) return "🟢 Active";
  try {
    const last = new Date(lastTime);
    if (isNaN(last.getTime())) return "🟢 Active";
    const now = new Date();
    const diff = now.getTime() - last.getTime();
    const minutesSince = diff / 60000;
    if (resetMinutes === 0) return minutesSince > 0 ? "🔴 Inactive" : "🟢 Active";
    if (minutesSince >= resetMinutes) return "🟢 Active";
    const remainingMs = resetMinutes * 60 * 1000 - diff;
    const remainingMin = Math.floor(remainingMs / 60000);
    const remainingSec = Math.floor((remainingMs % 60000) / 1000);
    return `🟡 Cooldown — ready in ${String(remainingMin).padStart(2, "0")}:${String(remainingSec).padStart(2, "0")}`;
  } catch {
    return "🟢 Active";
  }
}

export default function AlertsDashboard() {
  const [usdAmount, setUsdAmount] = useState(100);
  const [buyAlerts, setBuyAlerts] = useState<number[]>([]);
  const [sellAlerts, setSellAlerts] = useState<number[]>([]);
  const [lastBuyTimes, setLastBuyTimes] = useState<Record<string, string>>({});
  const [lastSellTimes, setLastSellTimes] = useState<Record<string, string>>({});
  const [alertResetMinutes, setAlertResetMinutes] = useState(0);
  const [newBuy, setNewBuy] = useState("");
  const [newSell, setNewSell] = useState("");
  const [history, setHistory] = useState<any[]>([]);
  const [latestBuyPrice, setLatestBuyPrice] = useState<number | null>(null);
  const [latestSellPrice, setLatestSellPrice] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [contract, setContract] = useState("");
  const [ticker, setTicker] = useState("");
  const [pairs, setPairs] = useState<string[]>([]);
  const [selectedPair, setSelectedPair] = useState("");
  const [alertType, setAlertType] = useState<'price' | 'marketcap'>("price");
  const [condition, setCondition] = useState<'above' | 'below'>("above");
  const [alertValue, setAlertValue] = useState("");
  const [channelId, setChannelId] = useState("");

  const fetchState = () => {
    fetch("/api/state")
      .then((res) => res.json())
      .then((data) => {
        setUsdAmount(data.usd_amount || 100);
        setBuyAlerts(data.buy_alerts || []);
        setSellAlerts(data.sell_alerts || []);
        setLastBuyTimes(data.last_triggered_buy || {});
        setLastSellTimes(data.last_triggered_sell || {});
        setAlertResetMinutes(data.alert_reset_minutes || 0);
        setHistory(data.latest_prices || []);
        const last = data.latest_prices?.at(-1);
        setLatestBuyPrice(last?.buy_price ?? null);
        setLatestSellPrice(last?.sell_price ?? null);
      })
      .catch(() => toast.error("Failed to load state"));
  };

  const fetchAlerts = () => {
    fetch("/api/alerts")
      .then((res) => res.json())
      .then(setAlerts)
      .catch(() => toast.error("Failed to load alerts"));
  };

  const fetchTokenInfo = async () => {
    if (!contract) return toast.error("Enter a contract address");
    const res = await fetch(`/api/token-info?contract=${contract}`);
    if (!res.ok) return toast.error("Token not found");
    const data = await res.json();
    setTicker(data.ticker);
    setPairs(data.pairs);
    setSelectedPair(data.pairs[0] || "");
  };

  const addNewAlert = async () => {
    if (!contract || !ticker || !selectedPair || !alertValue || !channelId) {
      return toast.error("Fill all fields");
    }
    const payload = {
      contract,
      ticker,
      pair: selectedPair,
      type: alertType,
      condition,
      value: parseFloat(alertValue),
      channel_id: channelId,
      guild_id: "", // Optionally add guild_id if you want to support it
    };
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      toast.success("Alert added");
      setContract("");
      setTicker("");
      setPairs([]);
      setSelectedPair("");
      setAlertValue("");
      setChannelId("");
      fetchAlerts();
    } else {
      const err = await res.json();
      toast.error(err.detail || "Failed to add alert");
    }
  };

  const removeAlert = async (id: string) => {
    const res = await fetch(`/api/alerts/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Alert removed");
      fetchAlerts();
    } else {
      toast.error("Failed to remove alert");
    }
  };

  useEffect(() => {
    fetchState();
    fetchAlerts();
    const interval = setInterval(fetchState, 60000);
    const refreshCountdown = setInterval(() => {
      setLastBuyTimes((prev) => ({ ...prev }));
      setLastSellTimes((prev) => ({ ...prev }));
    }, 1000);
    return () => {
      clearInterval(interval);
      clearInterval(refreshCountdown);
    };
  }, []);

  const applyUsdAmount = async () => {
    const amount = parseFloat(usdAmount.toString());
    if (isNaN(amount) || amount <= 0) return toast.error("Invalid USD amount");
    const res = await fetch("/api/usd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: amount }),
    });
    if (res.ok) {
      toast.success("USD amount updated");
      setHistory([]); // reset chart
    }
  };

  const applyResetMinutes = async () => {
    const res = await fetch("/api/reset-minutes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: alertResetMinutes }),
    });
    if (res.ok) {
      toast.success("Reset minutes updated");
      fetchState();
    }
  };

  const addAlert = async (type: "buy" | "sell", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return toast.error("Invalid price value");
    const res = await fetch(`/api/${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [num] }),
    });
    if (res.ok) {
      toast.success(`${type} alert added`);
      type === "buy" ? setNewBuy("") : setNewSell("");
      fetchState();
    }
  };

  const resetAlert = async (type: "buy" | "sell", value: number) => {
    const res = await fetch(`/api/reset-alert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: type, price: value }),
    });
    if (res.ok) {
      toast.success(`Reset ${type} alert`);
      fetchState();
    } else {
      toast.error("Failed to reset alert");
    }
  };

  const data = {
    labels: history.map((h) => h.timestamp || h.time || "-"),
    datasets: [
      {
        label: "Buy Price",
        data: history.map((h) => h.buy_price || h.buy || 0),
        borderColor: "#4ade80",
        fill: false,
      },
      {
        label: "Sell Price",
        data: history.map((h) => h.sell_price || h.sell || 0),
        borderColor: "#f87171",
        fill: false,
      },
    ],
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold mb-4">Jupiter USDC Price Alerts</h1>

      {/* Real-time Prices */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <h2 className="text-xl font-semibold">Buy Price</h2>
            <p className="text-2xl font-bold text-green-600">
              {latestBuyPrice !== null ? latestBuyPrice.toFixed(8) : "--"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <h2 className="text-xl font-semibold">Sell Price</h2>
            <p className="text-2xl font-bold text-red-500">
              {latestSellPrice !== null ? latestSellPrice.toFixed(8) : "--"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* New Multi-Token Alert Form */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <Label>New Alert</Label>
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:gap-4">
            <div className="flex flex-col gap-1">
              <Label>Contract Address</Label>
              <Input value={contract} onChange={e => setContract(e.target.value)} placeholder="Token contract address" />
            </div>
            <Button onClick={fetchTokenInfo}>Fetch</Button>
            {ticker && <div className="flex flex-col gap-1"><Label>Ticker</Label><span>{ticker}</span></div>}
            {pairs.length > 0 && (
              <div className="flex flex-col gap-1">
                <Label>Quote Currency</Label>
                <select value={selectedPair} onChange={e => setSelectedPair(e.target.value)} className="border rounded px-2 py-1">
                  {pairs.map(pair => <option key={pair} value={pair}>{pair}</option>)}
                </select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label>Type</Label>
              <div className="flex gap-2">
                <label><input type="radio" checked={alertType === 'price'} onChange={() => setAlertType('price')} /> Price</label>
                <label><input type="radio" checked={alertType === 'marketcap'} onChange={() => setAlertType('marketcap')} /> Market Cap</label>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Condition</Label>
              <div className="flex gap-2">
                <label><input type="radio" checked={condition === 'above'} onChange={() => setCondition('above')} /> Above</label>
                <label><input type="radio" checked={condition === 'below'} onChange={() => setCondition('below')} /> Below</label>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Value</Label>
              <Input type="number" value={alertValue} onChange={e => setAlertValue(e.target.value)} placeholder="Value" />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Discord Channel ID</Label>
              <Input value={channelId} onChange={e => setChannelId(e.target.value)} placeholder="Channel ID" />
              <span className="text-xs text-gray-500">Invite the bot to your server and paste the channel ID here.</span>
            </div>
            <Button onClick={addNewAlert}>Add Alert</Button>
          </div>
        </CardContent>
      </Card>

      {/* Multi-Token Alerts List */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <Label>Active Alerts</Label>
          <ul className="list-disc pl-5">
            {alerts.length === 0 && <li>No alerts set.</li>}
            {alerts.map((alert, i) => (
              <li key={alert.id || i} className="flex flex-col md:flex-row md:items-center md:gap-4 gap-2 justify-between">
                <span>
                  <b>{alert.ticker}/{alert.pair}</b> | {alert.type} {alert.condition} {alert.value} | Channel: <code>{alert.channel_id}</code>
                </span>
                <Button size="sm" variant="outline" onClick={() => removeAlert(alert.id)}>Remove</Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Rest of the UI remains unchanged */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <Label>Simulated USD Amount</Label>
          <div className="flex gap-2">
            <Input type="number" value={usdAmount} onChange={(e) => setUsdAmount(parseFloat(e.target.value))} />
            <Button onClick={applyUsdAmount}>Update</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <Label>Alert Reset Minutes (0 disables reset)</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              value={alertResetMinutes}
              onChange={(e) => setAlertResetMinutes(parseInt(e.target.value))}
            />
            <Button onClick={applyResetMinutes}>Update</Button>
          </div>
        </CardContent>
      </Card>

      {/* Chart */}
      <Card>
        <CardContent className="p-4">
          <h2 className="text-lg font-bold mb-2">Price Chart</h2>
          <Line
            data={data}
            options={{
              responsive: true,
              plugins: {
                tooltip: {
                  callbacks: {
                    label: function (ctx) {
                      return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(8)}`;
                    },
                  },
                },
                legend: {
                  display: true,
                  position: "top",
                },
              },
              scales: {
                y: {
                  ticks: {
                    callback: function (value) {
                      return Number(value).toFixed(8);
                    },
                  },
                },
              },
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

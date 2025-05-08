from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List
import json
import os
from datetime import datetime
import requests
import uuid
import asyncio
import discord
from fastapi import BackgroundTasks

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIG_PATH = "/shared/config.json"
STATE_PATH = "/shared/jupiter-latest.json"

state = {
    "usd_amount": 100.0,
    "buy_alerts": [],
    "sell_alerts": [],
    "latest_prices": [],
    "alert_reset_minutes": 0,
    "last_triggered_buy": {},
    "last_triggered_sell": {},
    "alerts": [],
}

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")

# Discord bot client (singleton)
discord_client = None

def get_discord_client():
    global discord_client
    if discord_client is None:
        intents = discord.Intents.default()
        discord_client = discord.Client(intents=intents)
    return discord_client

async def send_discord_message(channel_id: int, message: str):
    client = get_discord_client()
    if not client.is_ready():
        await client.wait_until_ready()
    channel = await client.fetch_channel(channel_id)
    await channel.send(message)

async def check_alerts_loop():
    await asyncio.sleep(5)  # Wait for FastAPI and Discord bot to be ready
    client = get_discord_client()
    await client.login(DISCORD_BOT_TOKEN)
    await client.connect()
    while True:
        try:
            await check_all_alerts()
        except Exception as e:
            print(f"[ALERT CHECK ERROR] {e}")
        await asyncio.sleep(60)

async def check_all_alerts():
    alerts = state.get("alerts", [])
    for alert in alerts:
        try:
            # Fetch price/marketcap from Dexscreener
            url = f"https://api.dexscreener.com/latest/dex/tokens/{alert['contract']}"
            resp = requests.get(url, timeout=10)
            if resp.status_code != 200:
                continue
            data = resp.json()
            pair_data = None
            for p in data.get('pairs', []):
                if p['quoteToken']['symbol'] == alert['pair']:
                    pair_data = p
                    break
            if not pair_data:
                continue
            if alert['type'] == 'price':
                value = float(pair_data.get('priceUsd', 0)) if alert['pair'] == 'USD' else float(pair_data.get('priceNative', 0))
            elif alert['type'] == 'marketcap':
                value = float(pair_data.get('fdv', 0))
            else:
                continue
            should_trigger = (
                (alert['condition'] == 'above' and value > alert['value']) or
                (alert['condition'] == 'below' and value < alert['value'])
            )
            if should_trigger:
                msg = f"**{alert['ticker']}/{alert['pair']}**\nAlert: {alert['type'].capitalize()} {alert['condition']} {alert['value']}\nCurrent: {value}\nContract: `{alert['contract']}`"
                await send_discord_message(int(alert['channel_id']), msg)
        except Exception as e:
            print(f"[ALERT ERROR] {e}")

@app.on_event("startup")
def start_background_tasks():
    if DISCORD_BOT_TOKEN:
        loop = asyncio.get_event_loop()
        loop.create_task(check_alerts_loop())

def safe_parse_alerts(value: str):
    try:
        return sorted(set([float(v.strip()) for v in value.split(",") if v.strip()]))
    except:
        return []

def load_env_defaults():
    try:
        state["usd_amount"] = float(os.getenv("USD_AMOUNT", state["usd_amount"]))
        state["buy_alerts"] = safe_parse_alerts(os.getenv("BUY_ALERTS", ""))
        state["sell_alerts"] = safe_parse_alerts(os.getenv("SELL_ALERTS", ""))
        state["alert_reset_minutes"] = int(os.getenv("ALERT_RESET_MINUTES", state["alert_reset_minutes"]))
    except Exception as e:
        print(f"⚠️ Failed to load ENV defaults: {e}")

def load_state():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                cfg = json.load(f)
                state["usd_amount"] = cfg.get("usd_amount", state["usd_amount"])
                state["buy_alerts"] = cfg.get("buy_alerts", state["buy_alerts"])
                state["sell_alerts"] = cfg.get("sell_alerts", state["sell_alerts"])
                state["alert_reset_minutes"] = cfg.get("alert_reset_minutes", state["alert_reset_minutes"])
        except Exception as e:
            print(f"⚠️ Failed to load config.json: {e}")

    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH) as f:
                s = json.load(f)
                state["latest_prices"] = s.get("latest_prices", [])
                state["last_triggered_buy"] = s.get("last_triggered_buy", {})
                state["last_triggered_sell"] = s.get("last_triggered_sell", {})
        except Exception as e:
            print(f"⚠️ Failed to load jupiter-latest.json: {e}")

def write_config():
    try:
        with open(CONFIG_PATH, "w") as f:
            json.dump({
                "usd_amount": state["usd_amount"],
                "buy_alerts": state["buy_alerts"],
                "sell_alerts": state["sell_alerts"],
                "alert_reset_minutes": state["alert_reset_minutes"]
            }, f, indent=2)
    except Exception as e:
        print(f"❌ Failed to write config.json: {e}")

def write_state():
    try:
        with open(STATE_PATH, "w") as f:
            json.dump({
                "latest_prices": state["latest_prices"],
                "last_triggered_buy": state["last_triggered_buy"],
                "last_triggered_sell": state["last_triggered_sell"]
            }, f, indent=2)
    except Exception as e:
        print(f"❌ Failed to write jupiter-latest.json: {e}")

load_env_defaults()
load_state()
write_config()
write_state()

# Models
class AlertValue(BaseModel):
    value: float

class AlertList(BaseModel):
    values: List[float]

class PriceData(BaseModel):
    timestamp: str
    buy_price: float
    sell_price: float

class ResetConfig(BaseModel):
    minutes: int

class TriggerUpdate(BaseModel):
    side: str
    price: float
    timestamp: str

class ResetAlert(BaseModel):
    side: str
    price: float

# New AlertModel for multi-token, multi-type alerts
class AlertModel(BaseModel):
    contract: str
    ticker: str
    pair: str
    type: str  # 'price' or 'marketcap'
    condition: str  # 'above' or 'below'
    value: float
    guild_id: str
    channel_id: str
    id: str = None

@app.get("/api/state")
async def get_state():
    return state

@app.post("/api/usd")
async def set_usd(alert: AlertValue):
    if alert.value <= 0:
        raise HTTPException(status_code=400, detail="USD amount must be positive")
    state["usd_amount"] = alert.value
    state["latest_prices"] = []  # Clear chart 🧹
    write_config()
    write_state()  # ✅ To persist wipe
    return {"success": True}


@app.post("/api/buy")
async def set_buy_alerts(alerts: AlertList):
    # Combine current alerts with new ones
    combined = set(state["buy_alerts"]) | set(alerts.values)
    state["buy_alerts"] = sorted(combined)
    write_config()
    return {"success": True}

@app.post("/api/sell")
async def set_sell_alerts(alerts: AlertList):
    # Combine current alerts with new ones
    combined = set(state["sell_alerts"]) | set(alerts.values)
    state["sell_alerts"] = sorted(combined)
    write_config()
    return {"success": True}

@app.delete("/api/buy")
async def delete_buy_alert(alert: AlertValue):
    value = round(alert.value, 8)
    if value in state["buy_alerts"]:
        state["buy_alerts"].remove(value)
        state["last_triggered_buy"].pop(f"{value:.8f}", None)
        write_config()
        write_state()
        return {"success": True}
    raise HTTPException(status_code=404, detail="Buy alert not found")

@app.delete("/api/sell")
async def delete_sell_alert(alert: AlertValue):
    value = round(alert.value, 8)
    if value in state["sell_alerts"]:
        state["sell_alerts"].remove(value)
        state["last_triggered_sell"].pop(f"{value:.8f}", None)
        write_config()
        write_state()
        return {"success": True}
    raise HTTPException(status_code=404, detail="Sell alert not found")

@app.post("/api/reset-minutes")
async def set_reset_minutes(config: ResetConfig):
    if config.minutes < 0:
        raise HTTPException(status_code=400, detail="Minutes must be >= 0")
    state["alert_reset_minutes"] = config.minutes
    write_config()
    return {"success": True, "minutes": config.minutes}

@app.post("/api/reset-alert")
async def reset_single_alert(data: ResetAlert):
    key = f"{data.price:.8f}"
    now = datetime.now().isoformat()
    if data.side == "buy":
        if key in [f"{v:.8f}" for v in state["buy_alerts"]]:
            state["last_triggered_buy"].pop(key, None)
            write_state()
            return {"success": True}
        raise HTTPException(status_code=404, detail="Buy alert not found")
    elif data.side == "sell":
        if key in [f"{v:.8f}" for v in state["sell_alerts"]]:
            state["last_triggered_sell"].pop(key, None)
            write_state()
            return {"success": True}
        raise HTTPException(status_code=404, detail="Sell alert not found")
    raise HTTPException(status_code=400, detail="Invalid alert side")

@app.post("/api/trigger")
async def update_last_triggered(data: TriggerUpdate):
    price_key = f"{data.price:.8f}"
    if data.side == "buy":
        state["last_triggered_buy"][price_key] = data.timestamp
    elif data.side == "sell":
        state["last_triggered_sell"][price_key] = data.timestamp
    write_state()
    return {"success": True}

@app.post("/api/price")
async def update_price(data: PriceData):
    state["latest_prices"].append(data.dict())
    state["latest_prices"] = state["latest_prices"][-100:]
    write_state()
    return {"success": True}

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

@app.get("/{full_path:path}")
async def serve_index(full_path: str):
    index_path = os.path.join("frontend", "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    raise HTTPException(status_code=404, detail="Page not found")

def get_token_info_from_dexscreener(contract: str):
    url = f"https://api.dexscreener.com/latest/dex/tokens/{contract}"
    resp = requests.get(url, timeout=10)
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Token not found on Dexscreener")
    data = resp.json()
    if not data.get('pairs'):
        raise HTTPException(status_code=404, detail="No pairs found for this token")
    # Get unique quote currencies and ticker
    pairs = data['pairs']
    quote_currencies = sorted(list(set(p['quoteToken']['symbol'] for p in pairs if 'quoteToken' in p and 'symbol' in p['quoteToken'])))
    ticker = pairs[0]['baseToken']['symbol'] if pairs and 'baseToken' in pairs[0] and 'symbol' in pairs[0]['baseToken'] else ''
    return {'ticker': ticker, 'pairs': quote_currencies}

@app.get("/api/token-info")
async def token_info(contract: str = Query(..., description="Token contract address")):
    return get_token_info_from_dexscreener(contract)

@app.get("/api/alerts")
async def get_alerts():
    return state["alerts"]

@app.post("/api/alerts")
async def add_alert(alert: AlertModel):
    # Assign a unique id if not provided
    if not alert.id:
        alert.id = str(uuid.uuid4())
    # Prevent duplicates (same contract, pair, type, condition, value)
    for a in state["alerts"]:
        if (
            a["contract"] == alert.contract and
            a["pair"] == alert.pair and
            a["type"] == alert.type and
            a["condition"] == alert.condition and
            a["value"] == alert.value
        ):
            raise HTTPException(status_code=400, detail="Duplicate alert")
    state["alerts"].append(alert.dict())
    write_config()
    return {"success": True, "id": alert.id}

@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str):
    before = len(state["alerts"])
    state["alerts"] = [a for a in state["alerts"] if a["id"] != alert_id]
    if len(state["alerts"]) == before:
        raise HTTPException(status_code=404, detail="Alert not found")
    write_config()
    return {"success": True}

import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v10 PRICE ACTION MODE 🚀");

// ============================
// ENV
// ============================

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const BASE_URL = "https://api-fxtrade.oanda.com/v3";

// ============================
// SETTINGS
// ============================

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

const RISK_PERCENT = 0.5;

const STOP_LOSS_PIPS = 15;
const TAKE_PROFIT_PIPS = 30;

const MAX_GLOBAL_TRADES = 3;

let activeTrades = {};

// ============================
// SESSION FILTER
// ============================

function sessionOpen() {

    const hour = new Date().getUTCHours();

    return hour >= 7 && hour <= 20;

}

// ============================
// GET BALANCE
// ============================

async function getBalance() {

    const res = await fetch(

        `${BASE_URL}/accounts/${ACCOUNT_ID}`,

        {

            headers: {

                Authorization: `Bearer ${API_KEY}`

            }

        }

    );

    const data = await res.json();

    return Number(data.account.balance);

}

// ============================
// GET PRICE
// ============================

async function getPrice(pair) {

    const res = await fetch(

        `${BASE_URL}/accounts/${ACCOUNT_ID}/pricing?instruments=${pair}`,

        {

            headers: {

                Authorization: `Bearer ${API_KEY}`

            }

        }

    );

    const data = await res.json();

    return Number(data.prices[0].closeoutAsk);

}

// ============================
// GET CANDLES FULL DATA
// ============================

async function getCandles(pair) {

    const res = await fetch(

        `${BASE_URL}/instruments/${pair}/candles?count=100&granularity=M5`,

        {

            headers: {

                Authorization: `Bearer ${API_KEY}`

            }

        }

    );

    const data = await res.json();

    return data.candles.map(c => ({

        close: Number(c.mid.c),
        open: Number(c.mid.o),
        high: Number(c.mid.h),
        low: Number(c.mid.l)

    }));

}

// ============================
// RSI
// ============================

function rsi(prices) {

    let gain = 0;
    let loss = 0;

    for (let i = prices.length - 14; i < prices.length - 1; i++) {

        const diff = prices[i + 1] - prices[i];

        if (diff > 0) gain += diff;
        else loss -= diff;

    }

    const rs = gain / loss;

    return 100 - 100 / (1 + rs);

}

// ============================
// EMA
// ============================

function ema(values, period) {

    const k = 2 / (period + 1);

    let val = values[0];

    for (let i = 1; i < values.length; i++) {

        val = values[i] * k + val * (1 - k);

    }

    return val;

}

// ============================
// TREND
// ============================

function trend(closes) {

    const e10 = ema(closes.slice(-20), 10);

    const e30 = ema(closes.slice(-50), 30);

    if (e10 > e30) return "UP";

    if (e10 < e30) return "DOWN";

    return "SIDEWAYS";

}

// ============================
// PIN BAR DETECTOR
// ============================

function pinBar(candle) {

    const body = Math.abs(candle.close - candle.open);

    const upperWick = candle.high - Math.max(candle.close, candle.open);

    const lowerWick = Math.min(candle.close, candle.open) - candle.low;

    if (lowerWick > body * 2) return "BULLISH";

    if (upperWick > body * 2) return "BEARISH";

    return "NONE";

}

// ============================
// BREAKOUT DETECTOR
// ============================

function breakout(candles) {

    const last = candles.at(-1);

    const prev = candles.at(-2);

    if (last.close > prev.high) return "UP";

    if (last.close < prev.low) return "DOWN";

    return "NONE";

}

// ============================
// POSITION SIZE
// ============================

function units(balance) {

    return Math.floor(balance * (RISK_PERCENT / 100) * 10);

}

// ============================
// OPEN TRADE
// ============================

async function openTrade(pair, unitsValue) {

    const price = await getPrice(pair);

    const sl = unitsValue > 0

        ? price - STOP_LOSS_PIPS * 0.0001

        : price + STOP_LOSS_PIPS * 0.0001;

    const tp = unitsValue > 0

        ? price + TAKE_PROFIT_PIPS * 0.0001

        : price - TAKE_PROFIT_PIPS * 0.0001;

    const order = {

        order: {

            instrument: pair,

            units: String(unitsValue),

            type: "MARKET",

            stopLossOnFill: { price: sl.toFixed(5) },

            takeProfitOnFill: { price: tp.toFixed(5) }

        }

    };

    await fetch(

        `${BASE_URL}/accounts/${ACCOUNT_ID}/orders`,

        {

            method: "POST",

            headers: {

                Authorization: `Bearer ${API_KEY}`,
                "Content-Type": "application/json"

            },

            body: JSON.stringify(order)

        }

    );

    console.log("TRADE OPENED", pair, unitsValue);

}

// ============================
// SIGNAL ENGINE
// ============================

async function analyze(pair) {

    if (!sessionOpen()) return;

    if (Object.keys(activeTrades).length >= MAX_GLOBAL_TRADES) return;

    if (activeTrades[pair]) return;

    const candles = await getCandles(pair);

    const closes = candles.map(c => c.close);

    const lastCandle = candles.at(-1);

    const trendDirection = trend(closes);

    const r = rsi(closes);

    const pin = pinBar(lastCandle);

    const br = breakout(candles);

    console.log(pair, "Trend:", trendDirection);

    console.log(pair, "RSI:", r.toFixed(2));

    console.log(pair, "PinBar:", pin);

    console.log(pair, "Breakout:", br);

    let signal = "WAIT";

    if (trendDirection === "UP" && pin === "BULLISH")

        signal = "BUY";

    if (trendDirection === "DOWN" && pin === "BEARISH")

        signal = "SELL";

    if (trendDirection === "UP" && br === "UP")

        signal = "BUY";

    if (trendDirection === "DOWN" && br === "DOWN")

        signal = "SELL";

    console.log(pair, "Signal:", signal);

    if (signal === "WAIT") return;

    const balance = await getBalance();

    const u = signal === "BUY"

        ? units(balance)

        : -units(balance);

    await openTrade(pair, u);

    activeTrades[pair] = true;

}

// ============================
// LOOP
// ============================

async function loop() {

    console.log("Trading loop started 🔁");

    while (true) {

        console.log("Heartbeat", new Date().toISOString());

        for (const pair of PAIRS)

            await analyze(pair);

        await new Promise(r => setTimeout(r, 60000));

    }

}

loop();

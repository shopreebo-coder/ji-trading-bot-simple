import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v8 LIVE MODE 🚀");

// ============================
// ENV
// ============================

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const BASE_URL = "https://api-fxtrade.oanda.com/v3";

// ============================
// SETTINGS
// ============================

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

const RISK_PERCENT = 0.5;

const RSI_PERIOD = 14;

const STOP_LOSS_PIPS = 15;
const TAKE_PROFIT_PIPS = 30;

let activeTrades = {};

// ============================
// GET CANDLES
// ============================

async function getCandles(pair) {

    const url =
        `${BASE_URL}/instruments/${pair}/candles?count=100&granularity=M5`;

    const response = await fetch(url, {

        headers: {
            Authorization: `Bearer ${OANDA_API_KEY}`
        }

    });

    const data = await response.json();

    return data.candles.map(c => Number(c.mid.c));
}

// ============================
// RSI
// ============================

function calculateRSI(prices) {

    let gains = 0;
    let losses = 0;

    for (let i = prices.length - RSI_PERIOD; i < prices.length - 1; i++) {

        const diff = prices[i + 1] - prices[i];

        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    const rs = gains / losses;

    return 100 - (100 / (1 + rs));
}

// ============================
// EMA
// ============================

function ema(prices, period) {

    const k = 2 / (period + 1);

    let emaValue = prices[0];

    for (let i = 1; i < prices.length; i++) {

        emaValue = prices[i] * k + emaValue * (1 - k);

    }

    return emaValue;
}

// ============================
// TREND FILTER
// ============================

function detectTrend(prices) {

    const ema10 = ema(prices.slice(-20), 10);

    const ema30 = ema(prices.slice(-50), 30);

    if (ema10 > ema30) return "UP";

    if (ema10 < ema30) return "DOWN";

    return "SIDEWAYS";
}

// ============================
// ENGULFING DETECTOR
// ============================

function detectEngulfing(prices) {

    const last = prices[prices.length - 1];

    const prev = prices[prices.length - 2];

    if (last > prev * 1.001) return "BULLISH";

    if (last < prev * 0.999) return "BEARISH";

    return "NONE";
}

// ============================
// ACCOUNT BALANCE
// ============================

async function getBalance() {

    const url =
        `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}`;

    const response = await fetch(url, {

        headers: {
            Authorization: `Bearer ${OANDA_API_KEY}`
        }

    });

    const data = await response.json();

    return Number(data.account.balance);
}

// ============================
// POSITION SIZE
// ============================

function calculateUnits(balance) {

    const riskAmount = balance * (RISK_PERCENT / 100);

    return Math.floor(riskAmount * 10);
}

// ============================
// OPEN TRADE
// ============================

async function openTrade(pair, units, price) {

    const sl =
        units > 0
        ? price - STOP_LOSS_PIPS * 0.0001
        : price + STOP_LOSS_PIPS * 0.0001;

    const tp =
        units > 0
        ? price + TAKE_PROFIT_PIPS * 0.0001
        : price - TAKE_PROFIT_PIPS * 0.0001;

    const order = {

        order: {

            instrument: pair,

            units: String(units),

            type: "MARKET",

            positionFill: "DEFAULT",

            stopLossOnFill: {

                price: sl.toFixed(5)

            },

            takeProfitOnFill: {

                price: tp.toFixed(5)

            }

        }

    };

    await fetch(

        `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/orders`,

        {

            method: "POST",

            headers: {

                Authorization: `Bearer ${OANDA_API_KEY}`,

                "Content-Type": "application/json"

            },

            body: JSON.stringify(order)

        }

    );

    console.log("TRADE OPENED:", pair, units);

}

// ============================
// SIGNAL ENGINE
// ============================

async function analyzePair(pair) {

    if (activeTrades[pair]) {

        console.log(pair, "already active trade");

        return;

    }

    console.log("Scanning", pair);

    const prices = await getCandles(pair);

    const price = prices[prices.length - 1];

    const rsi = calculateRSI(prices);

    const trend = detectTrend(prices);

    const engulfing = detectEngulfing(prices);

    let signal = "WAIT";

    if (trend === "UP" && rsi < 35 && engulfing === "BULLISH") {

        signal = "BUY";

    }

    if (trend === "DOWN" && rsi > 65 && engulfing === "BEARISH") {

        signal = "SELL";

    }

    console.log(pair, "RSI:", rsi.toFixed(2));

    console.log(pair, "Trend:", trend);

    console.log(pair, "Engulfing:", engulfing);

    console.log(pair, "Signal:", signal);

    if (signal !== "WAIT") {

        const balance = await getBalance();

        const units =
            signal === "BUY"
            ? calculateUnits(balance)
            : -calculateUnits(balance);

        await openTrade(pair, units, price);

        activeTrades[pair] = true;

    }

}

// ============================
// LOOP
// ============================

async function startTradingLoop() {

    console.log("Trading loop started 🔁");

    while (true) {

        console.log("Heartbeat:", new Date().toISOString());

        for (const pair of PAIRS) {

            try {

                await analyzePair(pair);

            }

            catch {

                console.log("Error scanning", pair);

            }

        }

        await new Promise(r => setTimeout(r, 60000));

    }

}

startTradingLoop();

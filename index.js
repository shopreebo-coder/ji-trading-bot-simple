import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v5 starting 🚀");

// ============================
// ENV VARIABLES
// ============================

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const OANDA_URL = "https://api-fxtrade.oanda.com/v3";

// ============================
// SETTINGS
// ============================

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD"];

const RSI_PERIOD = 14;

// ============================
// GET CANDLES
// ============================

async function getCandles(pair) {

    const url =
        `${OANDA_URL}/instruments/${pair}/candles?count=100&granularity=M5`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${OANDA_API_KEY}`
        }
    });

    const data = await response.json();

    return data.candles.map(c => Number(c.mid.c));
}

// ============================
// RSI CALCULATION
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
// TREND FILTER
// ============================

function detectTrend(prices) {

    const shortMA =
        prices.slice(-10).reduce((a, b) => a + b) / 10;

    const longMA =
        prices.slice(-30).reduce((a, b) => a + b) / 30;

    if (shortMA > longMA) return "UP";

    if (shortMA < longMA) return "DOWN";

    return "SIDEWAYS";
}

// ============================
// SIGNAL ENGINE
// ============================

async function analyzePair(pair) {

    console.log(`Scanning ${pair}...`);

    const prices = await getCandles(pair);

    const rsi = calculateRSI(prices);

    const trend = detectTrend(prices);

    let signal = "WAIT";

    if (rsi < 30 && trend === "UP") signal = "BUY";

    if (rsi > 70 && trend === "DOWN") signal = "SELL";

    console.log(`${pair} RSI: ${rsi.toFixed(2)}`);

    console.log(`${pair} Trend: ${trend}`);

    console.log(`${pair} Signal: ${signal}`);

}

// ============================
// MAIN LOOP
// ============================

async function startTradingLoop() {

    console.log("Trading loop started 🔁");

    while (true) {

        console.log("Heartbeat:", new Date().toISOString());

        for (const pair of PAIRS) {

            try {

                await analyzePair(pair);

            } catch (err) {

                console.log("Error scanning pair:", pair);

            }

        }

        await new Promise(resolve =>
            setTimeout(resolve, 60000)
        );
    }
}

startTradingLoop();

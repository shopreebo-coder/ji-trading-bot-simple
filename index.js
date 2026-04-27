import fetch from "node-fetch";

console.log("FOREX ENGINE PRO v11.2 ACTIVE MODE (C1) 🚀");

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_URL = "https://api-fxtrade.oanda.com/v3";

const SYMBOLS = [
"EUR_USD",
"GBP_USD",
"USD_JPY",
"AUD_USD",
"USD_CAD",
"EUR_JPY",
"XAU_USD"
];

const PRECISION = {
EUR_USD:5,
GBP_USD:5,
AUD_USD:5,
USD_CAD:5,
EUR_JPY:3,
USD_JPY:3,
XAU_USD:2
};

const RISK_PERCENT = 0.0035;
const MAX_TRADES_TOTAL = 4;

async function sendTelegram(msg){
try{
await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{
method:"POST",
headers:{'Content-Type':'application/json'},
body:JSON.stringify({
chat_id:TELEGRAM_CHAT_ID,
text:msg
})
});
}catch(e){}
}

async function getBalance(){
const r=await fetch(`${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}`,{
headers:{Authorization:`Bearer ${OANDA_API_KEY}`}
});
const d=await r.json();
return parseFloat(d.account.balance);
}

async function getOpenTrades(){
const r=await fetch(`${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,{
headers:{Authorization:`Bearer ${OANDA_API_KEY}`}
});
const d=await r.json();
return d.trades;
}

async function getCandles(symbol){
const r=await fetch(`${BASE_URL}/instruments/${symbol}/candles?count=20&granularity=M15`,{
headers:{Authorization:`Bearer ${OANDA_API_KEY}`}
});
const d=await r.json();
return d.candles.map(c=>parseFloat(c.mid.c));
}

function getRSI(data,period=14){
let gains=0;
let losses=0;

for(let i=1;i<data.length;i++){
const diff=data[i]-data[i-1];
if(diff>0) gains+=diff;
else losses-=diff;
}

if(losses===0) return 100;

const rs=gains/losses;
return 100-(100/(1+rs));
}

function breakout(candles){
return candles[candles.length-1]>Math.max(...candles.slice(-5,-1));
}

function breakdown(candles){
return candles[candles.length-1]<Math.min(...candles.slice(-5,-1));
}

function formatPrice(symbol,price){
return price.toFixed(PRECISION[symbol]);
}

function units(balance,price){
return Math.floor((balance*RISK_PERCENT/price)*100);
}

async function price(symbol){
const r=await fetch(`${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbol}`,{
headers:{Authorization:`Bearer ${OANDA_API_KEY}`}
});
const d=await r.json();
return parseFloat(d.prices[0].bids[0].price);
}

async function trade(symbol,dir){

const bal=await getBalance();
const p=await price(symbol);

const u=units(bal,p);

if(u<=0)return;

const sl=dir==="BUY"?p*0.997:p*1.003;
const tp=dir==="BUY"?p*1.007:p*0.993;

await fetch(`${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/orders`,{
method:"POST",
headers:{
Authorization:`Bearer ${OANDA_API_KEY}`,
"Content-Type":"application/json"
},
body:JSON.stringify({
order:{
instrument:symbol,
units:dir==="BUY"?u:-u,
type:"MARKET",
timeInForce:"FOK",
positionFill:"DEFAULT",
stopLossOnFill:{price:formatPrice(symbol,sl)},
takeProfitOnFill:{price:formatPrice(symbol,tp)}
}
})
});

await sendTelegram(`${dir} ${symbol}
SL:${formatPrice(symbol,sl)}
TP:${formatPrice(symbol,tp)}`);

}

async function signal(symbol){

const candles=await getCandles(symbol);
const rsi=getRSI(candles);

if(rsi<40 && breakout(candles)) return "BUY";

if(rsi>60 && breakdown(candles)) return "SELL";

return "WAIT";

}

async function run(){

console.log("New M15 cycle started");

const open=await getOpenTrades();

if(open.length>=MAX_TRADES_TOTAL){
console.log("Max trades reached");
return;
}

const openSymbols=open.map(t=>t.instrument);

for(const s of SYMBOLS){

if(openSymbols.includes(s))continue;

const sig=await signal(s);

if(sig==="WAIT")continue;

await trade(s,sig);

break;

}

}

await sendTelegram("FOREX ENGINE PRO v11.2 ACTIVE MODE started ✅");

run();

setInterval(run,900000);

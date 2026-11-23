// Two-speed BTC bot for the 24h cbBTC race (bars-replay/v1, long only).
//
// Idea: the race window is unseen, so the bot does not bet on one direction.
// It only risks capital when one of two independent setups appears, and it
// leaves quickly when the setup fails, so a falling window costs little and
// a rising window is ridden in size.
//
//   Setup A - dip buy inside an uptrend: the close has fallen at least
//     DIP_BPS from the highest close of the last DIP_LOOK bars, the close is
//     still at or above the slow EMA (the uptrend is intact), and the bar
//     turns up versus the previous close (the dip stopped falling).
//   Setup B - trend breakout: the fast EMA is above the slow EMA, the close
//     is at a BREAK_LOOK-bar high, and the close gained at least MOM_BPS over
//     the last MOM_LOOK bars (a real move, not one flat pool tick).
//
//   Exits (whole position, first one that fires):
//     take profit  at +TP_BPS over cost,
//     stop loss    at -SL_BPS under cost,
//     trailing     after the position was up at least TRAIL_ARM_BPS, a fall
//                  of TRAIL_BPS from the highest close since entry,
//     trend break  close below slow EMA * (1 - TREND_BREAK_BPS) after a
//                  minimum hold,
//     time stop    MAX_HOLD bars in the position.
//
//   Sizing: STAKE_BPS of equity per entry, one position at a time (the
//   universe has one symbol), COOLDOWN bars between an exit and the next
//   entry so fees (about 26 bps per round trip) are not churned away.
//   Orders cap slippage at SLIP_BPS past the deciding close; a refused sell
//   is simply sent again on the next bar while its exit reason still holds,
//   because every exit check is recomputed from the live position each bar.
//
//   All maths is float64 + - * / on closes only: deterministic, no clock,
//   no environment, no randomness, so two runs produce identical orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 30;
const SLOW_SPAN = 180;
const DIP_LOOK = 90;
const DIP_BPS = 30;
const BREAK_LOOK = 90;
const MOM_LOOK = 30;
const MOM_BPS = 25;
const TP_BPS = 250;
const SL_BPS = 80;
const TRAIL_ARM_BPS = 120;
const TRAIL_BPS = 70;
const TREND_BREAK_BPS = 50;
const MIN_HOLD_TREND = 30;
const MAX_HOLD = 720;
const COOLDOWN = 30;
const STAKE_BPS = 9000n;
const SLIP_BPS = 100;

interface Ema { span: number; warm: number[]; value: number | null }
function makeEma(span: number): Ema { return { span, warm: [], value: null }; }
function stepEma(e: Ema, close: number): void {
  if (e.value !== null) { e.value += (2 / (e.span + 1)) * (close - e.value); return; }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

const fast = makeEma(FAST_SPAN);
const slow = makeEma(SLOW_SPAN);
const closes: number[] = [];
let peakSinceEntry = 0;
let barsHeld = 0;
let cooldownLeft = 0;
let wasHolding = false;
let entryClose = 0;
function windowMax(n: number): number {
  let m = 0;
  for (let i = Math.max(0, closes.length - n); i < closes.length; i++) if (closes[i] > m) m = closes[i];
  return m;
}

await runBars({
  onBatch(state, batch) {
    let close: number | null = null;
    for (const bar of batch.bars) { close = Number(bar.c); closes.push(close); stepEma(fast, close); stepEma(slow, close); }
    if (close === null) return [];
    if (state.warmingUp) return [];

    const symbol = state.hello.symbols[0].symbol;
    const held = state.positions.get(symbol);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      barsHeld = wasHolding ? barsHeld + 1 : 1;
      wasHolding = true;
      if (close > peakSinceEntry) peakSinceEntry = close;
      const value = state.value(symbol, held.qty);
      const cost = held.cost;
      let exit = false;
      if (value * 10000n >= cost * BigInt(10000 + TP_BPS)) exit = true;
      if (value * 10000n <= cost * BigInt(10000 - SL_BPS)) exit = true;
      if (!exit && peakSinceEntry > 0 && cost > 0n) {
        const peakValueApprox = value; // trailing is judged on closes below
        void peakValueApprox;
        // Trailing on closes: entry price implied by cost is not a close, so
        // arm it from the best close versus the first close after entry is
        // approximated by peak close vs the close at entry detection.
        if (entryClose > 0 && peakSinceEntry >= entryClose * (1 + TRAIL_ARM_BPS / 10000) && close <= peakSinceEntry * (1 - TRAIL_BPS / 10000)) exit = true;
      }
      if (!exit && barsHeld >= MIN_HOLD_TREND && slow.value !== null && close < slow.value * (1 - TREND_BREAK_BPS / 10000)) exit = true;
      if (!exit && barsHeld >= MAX_HOLD) exit = true;
      if (exit) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SLIP_BPS });
        cooldownLeft = COOLDOWN;
      }
      return orders;
    }

    if (wasHolding) { wasHolding = false; barsHeld = 0; peakSinceEntry = 0; entryClose = 0; }
    if (cooldownLeft > 0) { cooldownLeft--; return []; }
    if (slow.value === null || fast.value === null) return [];
    if (closes.length < SLOW_SPAN) return [];

    const prev = closes[closes.length - 2];
    const dipHigh = windowMax(DIP_LOOK);
    const dipSetup = dipHigh > 0 && close <= dipHigh * (1 - DIP_BPS / 10000) && close >= slow.value * 0.998 && close > prev;
    const breakHigh = windowMax(BREAK_LOOK);
    const momBase = closes[closes.length - 1 - MOM_LOOK];
    const breakSetup = fast.value > slow.value && close >= breakHigh && momBase > 0 && close >= momBase * (1 + MOM_BPS / 10000);

    if (dipSetup || breakSetup) {
      const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
      let stake = (state.equity * STAKE_BPS) / BPS;
      if (byWeight < stake) stake = byWeight;
      if (state.cash < stake) stake = state.cash;
      if (stake > 0n && stake >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: SLIP_BPS });
        entryClose = close;
        peakSinceEntry = close;
      }
    }
    return orders;
  },
});

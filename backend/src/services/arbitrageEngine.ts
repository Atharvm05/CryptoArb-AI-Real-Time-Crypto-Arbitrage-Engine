import { FundingRateData, TickerData } from './exchangeService';

export interface ArbitrageOpportunity {
  asset: string;
  longExchange: string;
  shortExchange: string;
  longFundingRate: number;
  shortFundingRate: number;
  spread: number;
  expectedProfitPer10k: number;
  timestamp: number;
}

export interface CrossExchangeOpportunity {
  asset: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  spread: number;
  spreadPct: number;
  timestamp: number;
}

export interface SpotFuturesOpportunity {
  asset: string;
  exchange: string;
  spotPrice: number;
  futuresPrice: number;
  spread: number;
  spreadPct: number;
  direction: 'PREMIUM' | 'DISCOUNT';
  timestamp: number;
}

export interface FundingMatrixRow {
  coin: string;
  rates: Record<string, number>; // exchangeId -> rate
  bestSpread: number;
  longExchange: string;
  shortExchange: string;
  opportunity: string;
  liquidityScore: number;
  rankScore: number;
}

export const calculateFundingMatrix = (
  rates: FundingRateData[]
): FundingMatrixRow[] => {
  const coinGroups: Record<string, FundingRateData[]> = {};

  // Group by coin symbol
  rates.forEach((rate) => {
    if (!coinGroups[rate.coin]) {
      coinGroups[rate.coin] = [];
    }
    coinGroups[rate.coin]!.push(rate);
  });

  const matrix: FundingMatrixRow[] = [];

  for (const [coin, coinRates] of Object.entries(coinGroups)) {
    if (coinRates.length < 2) continue;

    const ratesMap: Record<string, number> = {};
    let minRate = Infinity;
    let maxRate = -Infinity;
    let longExchange = '';
    let shortExchange = '';

    coinRates.forEach((r) => {
      ratesMap[r.exchange] = r.fundingRate;
      if (r.fundingRate < minRate) {
        minRate = r.fundingRate;
        longExchange = r.exchange;
      }
      if (r.fundingRate > maxRate) {
        maxRate = r.fundingRate;
        shortExchange = r.exchange;
      }
    });

    const spread = maxRate - minRate;
    // Liquidity score placeholder (could be based on volume if available)
    const liquidityScore = 1.0; 
    const rankScore = spread * liquidityScore;

    matrix.push({
      coin,
      rates: ratesMap,
      bestSpread: spread,
      longExchange,
      shortExchange,
      opportunity: `Long ${longExchange} / Short ${shortExchange}`,
      liquidityScore,
      rankScore,
    });
  }

  // Sort by rankScore (spread * liquidity) descending
  return matrix.sort((a, b) => b.rankScore - a.rankScore);
};

export const findFundingArbitrageOpportunities = (
  rates: FundingRateData[]
): ArbitrageOpportunity[] => {
  if (rates.length < 2) return [];

  const opportunities: ArbitrageOpportunity[] = [];
  const symbolGroups: Record<string, FundingRateData[]> = {};

  // Group by symbol
  rates.forEach((rate) => {
    const group = symbolGroups[rate.symbol];
    if (!group) {
      symbolGroups[rate.symbol] = [rate];
    } else {
      group.push(rate);
    }
  });

  // Calculate spreads
  for (const [symbol, groupRates] of Object.entries(symbolGroups)) {
    if (groupRates.length < 2) continue;

    // Sort to find min and max rates
    groupRates.sort((a, b) => a.fundingRate - b.fundingRate);

    const minRate = groupRates[0]!;
    const maxRate = groupRates[groupRates.length - 1]!;

    const spread = maxRate.fundingRate - minRate.fundingRate;

    // Minimum spread threshold (0.01%)
    if (spread > 0.0001) {
      opportunities.push({
        asset: symbol,
        longExchange: minRate.exchange,
        shortExchange: maxRate.exchange,
        longFundingRate: minRate.fundingRate,
        shortFundingRate: maxRate.fundingRate,
        spread: spread,
        expectedProfitPer10k: 10000 * spread,
        timestamp: Date.now(),
      });
    }
  }

  return opportunities.sort((a, b) => b.spread - a.spread);
};

export const findCrossExchangeOpportunities = (
  tickers: TickerData[]
): CrossExchangeOpportunity[] => {
  if (tickers.length < 2) return [];

  const opportunities: CrossExchangeOpportunity[] = [];
  const symbolGroups: Record<string, TickerData[]> = {};

  tickers.forEach((ticker) => {
    // Only compare Spot markets for cross-exchange arbitrage
    const isFutures = ticker.symbol.includes(':') || 
                      ticker.symbol.includes('PERP') || 
                      ticker.symbol.includes('SWAP') || 
                      ticker.symbol.includes('-USD');
    if (isFutures) return;

    // Standardize symbol (e.g., BTC/USDT)
    let symbol = ticker.symbol.toUpperCase().replace('-', '/');
    // Handle cases like BTCUSDT (Binance style) if needed, but CCXT usually provides /
    if (!symbol.includes('/')) return;
    
    // Ensure it's a USDT pair
    if (!symbol.includes('/USDT')) return;
    
    // Strip everything after USDT (e.g. BTC/USDT:USDT -> BTC/USDT)
    symbol = symbol.split(':')[0];

    if (!symbolGroups[symbol]) {
        symbolGroups[symbol] = [ticker];
    } else {
        symbolGroups[symbol].push(ticker);
    }
  });

  for (const [symbol, groupTickers] of Object.entries(symbolGroups)) {
    if (groupTickers.length < 2) continue;

    // Sort by ask price to find cheapest place to buy
    const sortedByAsk = [...groupTickers].filter(t => t.ask > 0).sort((a, b) => a.ask - b.ask);
    // Sort by bid price to find most expensive place to sell
    const sortedByBid = [...groupTickers].filter(t => t.bid > 0).sort((a, b) => b.bid - a.bid);

    if (sortedByAsk.length === 0 || sortedByBid.length === 0) continue;

    const cheapestBuy = sortedByAsk[0]!;
    const expensiveSell = sortedByBid[0]!;

    // Ensure we are comparing different exchanges
    if (cheapestBuy.exchange === expensiveSell.exchange) {
      // Find the next best options if available
      // For simplicity, we just skip if the best is on the same exchange (unlikely for best buy vs best sell)
      if (sortedByAsk.length > 1 && sortedByAsk[1]!.exchange !== expensiveSell.exchange) {
        // use cheapestBuy and expensiveSell
      } else if (sortedByBid.length > 1 && sortedByBid[1]!.exchange !== cheapestBuy.exchange) {
        // use cheapestBuy and expensiveSell
      } else {
        // If we only have one exchange for this asset, skip
        if (new Set(groupTickers.map(t => t.exchange)).size < 2) continue;
      }
    }

    const buyPrice = cheapestBuy.ask;
    const sellPrice = expensiveSell.bid;
    const spread = sellPrice - buyPrice;
    const spreadPct = (spread / buyPrice) * 100;

    // Threshold 0.01% to detect even small differences, 
    // though users will filter for profitable ones (>0.1% usually)
    if (Math.abs(spreadPct) > 0.01 && spreadPct < 50) { // filter bad data > 50%
      opportunities.push({
        asset: symbol,
        buyExchange: cheapestBuy.exchange,
        sellExchange: expensiveSell.exchange,
        buyPrice: buyPrice,
        sellPrice: sellPrice,
        spread: spread,
        spreadPct: spreadPct,
        timestamp: Date.now(),
      });
    }
  }

  return opportunities.sort((a, b) => b.spreadPct - a.spreadPct);
};

export const findSpotFuturesOpportunities = (
  tickers: TickerData[],
  fundingRates: FundingRateData[]
): SpotFuturesOpportunity[] => {
  const opportunities: SpotFuturesOpportunity[] = [];

  // 1. Group tickers by exchange and base symbol
  const exchangeGroups: Record<string, Record<string, { spot?: TickerData; futures?: TickerData }>> = {};

  tickers.forEach(t => {
    if (!t.exchange) return;
    if (!exchangeGroups[t.exchange]) exchangeGroups[t.exchange] = {};
    
    const symbol = t.symbol.toUpperCase();
    // Support both BTC/USDT and BTC-USDT
    const parts = symbol.includes('/') ? symbol.split('/') : symbol.split('-');
    if (parts.length === 0) return;
    
    const basePart = parts[0] || '';
    const baseSymbol = basePart.split(':')[0];
    if (!baseSymbol) return;

    const group = exchangeGroups[t.exchange];
    if (!group) return;

    if (!group[baseSymbol]) {
      group[baseSymbol] = {};
    }

    const assetData = group[baseSymbol];
    if (!assetData) return;

    // More robust futures detection
    const isFutures = symbol.includes(':') || 
                      symbol.includes('PERP') || 
                      symbol.includes('SWAP') || 
                      symbol.includes('-USD') ||
                      (t.symbol.includes('/') && t.symbol.split('/')[1]?.includes(':'));

    if (isFutures) {
      assetData.futures = t;
    } else if (symbol.includes('USDT')) {
      assetData.spot = t;
    }
  });

  // 2. Also check fundingRates for markPrice which often represents the futures price source
  fundingRates.forEach(rate => {
    if (!rate.exchange) return;
    if (!exchangeGroups[rate.exchange]) exchangeGroups[rate.exchange] = {};
    
    const baseSymbol = rate.coin.toUpperCase();
    if (!baseSymbol) return;
    
    const group = exchangeGroups[rate.exchange];
    if (!group) return;

    if (!group[baseSymbol]) {
      group[baseSymbol] = {};
    }

    const assetData = group[baseSymbol];
    if (!assetData) return;

    if (rate.markPrice && (!assetData.futures || assetData.futures.last === 0)) {
      assetData.futures = {
        exchange: rate.exchange,
        symbol: rate.symbol,
        bid: 0,
        ask: 0,
        last: rate.markPrice,
        timestamp: rate.timestamp
      };
    }
  });

  // 3. Calculate spreads for coins that have BOTH spot and futures on the SAME exchange
  let matchCount = 0;
  for (const [exchange, assets] of Object.entries(exchangeGroups)) {
    for (const [asset, data] of Object.entries(assets)) {
      if (data.spot && data.futures) {
        matchCount++;
        const spotPrice = data.spot.last;
        const futuresPrice = data.futures.last;

        if (spotPrice > 0 && futuresPrice > 0) {
          // Double check it's not the same instrument
          if (data.spot.symbol === data.futures.symbol) continue;

          const spread = futuresPrice - spotPrice;
          const spreadPct = (spread / spotPrice) * 100;

          // Filter out extreme outliers (usually bad data)
          if (Math.abs(spreadPct) > 50) continue;

          opportunities.push({
            asset: `${asset}/USDT`,
            exchange: exchange,
            spotPrice,
            futuresPrice,
            spread,
            spreadPct,
            direction: spreadPct > 0 ? 'PREMIUM' : 'DISCOUNT',
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // console.log(`Spot vs Futures: Found ${matchCount} total asset matches, ${opportunities.length} valid opportunities.`);

  // Sort by highest absolute spread first and limit to top results
  return opportunities
    .sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
};

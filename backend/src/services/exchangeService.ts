export {};

import ccxt, { Exchange } from 'ccxt';

const SUPPORTED_EXCHANGES = [
  'binance',
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
  'mexc',
  'htx',
  'bingx',
  'phemex',
  'coinex',
  'ascendex',
  'deribit',
  'dydx',
  'hyperliquid',
];

interface ExchangeInstance {
  id: string;
  client: Exchange;
}

const exchanges: ExchangeInstance[] = [];
const spotExchanges: ExchangeInstance[] = [];
const swapExchanges: ExchangeInstance[] = [];

// Cache for funding rates
let fundingRatesCache: FundingRateData[] = [];
let lastFetchTimestamp = 0;
const CACHE_TTL = 30000; // 30 seconds for bulk funding data

// New: Per-exchange rate limiting and concurrent fetching management
const exchangeFetchStatus: Record<string, { lastFetch: number; isFetching: boolean }> = {};
const MIN_FETCH_INTERVAL = 10000; // 10 seconds per exchange minimum

export const initExchanges = async () => {
  for (const exchangeId of SUPPORTED_EXCHANGES) {
    try {
      const ccxtExchanges = (ccxt as any).exchanges || [];
      if (ccxtExchanges.includes(exchangeId) || exchangeId === 'hyperliquid') {
        const exchangeClass = (ccxt as any)[exchangeId];
        
        // Perpetual swaps client
        const swapClient: Exchange = new exchangeClass({
          enableRateLimit: true,
          timeout: FETCH_TIMEOUT,
          options: { defaultType: 'swap' },
        });
        swapExchanges.push({ id: exchangeId, client: swapClient });

        // Spot client (if supported by exchange)
        const spotClient: Exchange = new exchangeClass({
          enableRateLimit: true,
          timeout: FETCH_TIMEOUT,
          options: { defaultType: 'spot' },
        });
        spotExchanges.push({ id: exchangeId, client: spotClient });

        // Default client (legacy)
        exchanges.push({ id: exchangeId, client: swapClient });
        
        exchangeFetchStatus[exchangeId] = { lastFetch: 0, isFetching: false };
        console.log(`Initialized exchange: ${exchangeId}`);
      } else {
        console.warn(`Exchange ${exchangeId} not found in ccxt.`);
      }
    } catch (error) {
      console.error(`Failed to initialize ${exchangeId}:`, error);
    }
  }
  console.log(`Successfully initialized ${exchanges.length} exchanges.`);
};

export interface FundingRateData {
  exchange: string;
  symbol: string; // Original symbol (e.g., BTC/USDT:USDT)
  coin: string;   // Normalized coin (e.g., BTC)
  fundingRate: number;
  timestamp: number;
  markPrice?: number;
  volume24h?: number;
}

export interface TickerData {
  exchange: string;
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

const FETCH_TIMEOUT = 8000; // Increased slightly for stability but still bounded

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
  ]);
};

export const fetchAllFundingRatesInternal = async (): Promise<FundingRateData[]> => {
  const now = Date.now();
  
  // Use a more aggressive background update strategy
  // If we have any data, return it immediately and update in background if stale
  if (fundingRatesCache.length > 0 && (now - lastFetchTimestamp < CACHE_TTL)) {
    return fundingRatesCache;
  }

  // To prevent blocking, we fetch in chunks or parallel with strict per-exchange limits
  const promises = exchanges.map(async ({ id, client }) => {
    const status = exchangeFetchStatus[id];
    if (status?.isFetching) return null; // Skip if already fetching this exchange
    if (status && (now - status.lastFetch < MIN_FETCH_INTERVAL)) return null; // Respect rate limit

    try {
      if (status) status.isFetching = true;
      
      if (Object.keys(client.markets || {}).length === 0) {
        await withTimeout(client.loadMarkets(), FETCH_TIMEOUT);
      }

      let rates: any = {};
      if (client.has['fetchFundingRates']) {
        rates = await withTimeout(client.fetchFundingRates(), FETCH_TIMEOUT);
      } else if (client.has['fetchFundingRate']) {
        const btcSymbol = id === 'deribit' ? 'BTC-PERPETUAL' : (id === 'kucoin' ? 'BTC/USDT' : 'BTC/USDT:USDT');
        try {
          const rate = await withTimeout(client.fetchFundingRate(btcSymbol), FETCH_TIMEOUT);
          rates = { [btcSymbol]: rate };
        } catch (e: any) {
          return null;
        }
      }

      if (status) {
        status.lastFetch = Date.now();
        status.isFetching = false;
      }

      if (!rates || Object.keys(rates).length === 0) return null;

      return Object.values(rates).map((r: any) => {
        if (!r || !r.symbol) return null;
        const symbol = r.symbol;
        const coin = symbol.split('/')[0].split(':')[0].split('-')[0];
        if (!coin || coin.length > 10) return null;

        return {
          exchange: id,
          symbol: symbol,
          coin: coin,
          fundingRate: r.fundingRate || 0,
          timestamp: r.timestamp || now,
          markPrice: r.markPrice,
        };
      }).filter(r => r !== null) as FundingRateData[];
    } catch (error: any) {
      if (status) status.isFetching = false;
      return null;
    }
  });

  const results = await Promise.allSettled(promises);
  const newRates: FundingRateData[] = [];
  
  results.forEach((result) => {
    if (result.status === 'fulfilled' && result.value) {
      newRates.push(...result.value);
    }
  });

  if (newRates.length > 0) {
    // Merge new rates with existing cache to keep data for exchanges that failed this round
    const merged = [...fundingRatesCache];
    newRates.forEach(nr => {
      const idx = merged.findIndex(mr => mr.exchange === nr.exchange && mr.symbol === nr.symbol);
      if (idx !== -1) {
        merged[idx] = nr;
      } else {
        merged.push(nr);
      }
    });
    fundingRatesCache = merged;
    lastFetchTimestamp = now;
  }

  return fundingRatesCache;
};

let tickersCache: TickerData[] = [];
let lastTickerFetchTimestamp = 0;
const TICKER_CACHE_TTL = 10000; // Keep slightly longer for stability on Render free tier

export const fetchTickersForExchanges = async (): Promise<TickerData[]> => {
  const now = Date.now();
  if (now - lastTickerFetchTimestamp < TICKER_CACHE_TTL && tickersCache.length > 0) {
    return tickersCache;
  }

  // Scan a broader range of exchanges for Spot vs Futures and Cross-Exchange
  const svfIds = ['binance', 'bybit', 'okx', 'bitget', 'kucoin'];
  
  const spotToFetch = spotExchanges.filter(e => svfIds.includes(e.id));
  const swapToFetch = swapExchanges.filter(e => svfIds.includes(e.id));

  // Limit concurrency for tickers to avoid IP bans and slow responses
  // Use a smaller batch size to prevent overloading the event loop
  const fetchTickerBatch = async (instances: ExchangeInstance[]) => {
    const results = [];
    // Process in smaller parallel chunks of 3 to stay within memory limits on Render free tier
    for (let i = 0; i < instances.length; i += 3) {
      const chunk = instances.slice(i, i + 3);
      const chunkResults = await Promise.all(chunk.map(async ({ id, client }) => {
        try {
          if (Object.keys(client.markets || {}).length === 0) {
            await withTimeout(client.loadMarkets(), FETCH_TIMEOUT);
          }
          if (!client.has['fetchTickers']) return [];
          const tickers = await withTimeout(client.fetchTickers(), FETCH_TIMEOUT);
          return formatTickers(id, tickers);
        } catch (e) { 
          console.error(`Error fetching tickers for ${id}:`, e);
          return []; 
        }
      }));
      results.push(...chunkResults);
    }
    return results;
  };

  const [spotResults, swapResults] = await Promise.all([
    fetchTickerBatch(spotToFetch),
    fetchTickerBatch(swapToFetch)
  ]);

  const allTickers: TickerData[] = [];
  [...spotResults, ...swapResults].forEach(res => allTickers.push(...res));

  tickersCache = allTickers;
  lastTickerFetchTimestamp = now;
  return allTickers;
};

const formatTickers = (exchangeId: string, tickers: any): TickerData[] => {
    return Object.values(tickers)
        .filter((t: any) => t && t.symbol && (t.symbol.includes('/USDT') || t.symbol.includes(':USDT') || t.symbol.includes('-USDT'))) 
        .map((t: any) => {
            const baseSymbol = t.symbol.split('/')[0].split(':')[0].split('-')[0];
            if (!baseSymbol || baseSymbol.length > 10) return null;
            return {
                exchange: exchangeId,
                symbol: t.symbol,
                bid: t.bid || 0,
                ask: t.ask || 0,
                last: t.last || 0,
                timestamp: t.timestamp || Date.now()
            } as TickerData;
        }).filter(t => t !== null) as TickerData[];
};

export const fetchAllMarketData = async () => {
  const [fundingRates, tickers] = await Promise.all([
    fetchAllFundingRatesInternal(),
    fetchTickersForExchanges()
  ]);
  return { fundingRates, tickers };
};

export const getExchanges = () => exchanges;

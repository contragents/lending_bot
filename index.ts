import {CONFIG, getEnv, LENDING, POOLS} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';



import {estimatePriceImpact} from './utils.js';
import {getMoonwellData, getMoonwellPositions, getJumperQuote, get0xQuoteV2, getUniswapPoolPrice} from './utils.js';
import {provider} from "./config.js";

import { initializeMTokensCache, type MTokensCache } from './utils.js';

async function main() {


    await getMoonwellData(); // Общий статус
    await getMoonwellPositions(); // Детальный список позиций

    //await getJumperQuote();
    //await get0xQuoteV2("1.0");
    if(CONFIG.CHAIN === 'OPT') {
        // Объявляем переменную и сразу заполняем её данными из блокчейна
        const mTokensCache: MTokensCache = await initializeMTokensCache(provider);

        // await getUniswapPoolPrice(provider);
        // await estimatePriceImpact(provider, 1000, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
        // await estimatePriceImpact(provider, 1000, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
    }
}

main();

import {CONFIG, getEnv, LENDING, POOLS} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';





import {loadWallet} from './utils.js'; // Не забываем .js для ESM
import {estimatePriceImpact} from './utils.js';
import {getMoonwellData, getMoonwellPositions, getJumperQuote, get0xQuoteV2, getUniswapPoolPrice} from './utils.js';
import {provider} from "./config.js";



async function main() {

    await getMoonwellData(); // Общий статус
    await getMoonwellPositions(); // Детальный список позиций

    await getJumperQuote();
    await get0xQuoteV2("1.0");
    if(CONFIG.CHAIN === 'OPT') {
        await getUniswapPoolPrice(provider);
        await estimatePriceImpact(provider, 1000, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
        await estimatePriceImpact(provider, 1000, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
    }
}

main();

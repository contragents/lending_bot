import {CONFIG, getEnv, LENDING, POOLS} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';



import {estimatePriceImpact, wallet} from './utils.js';
import {getJumperQuote, get0xQuoteV2, getUniswapPoolPrice, getWalletBalances} from './utils.js';
import {provider} from "./config.js";
import {getMoonwellData, getMoonwellPositions, borrowMoonwellAsset} from './moonwellUtils.js';

async function main() {


    await getMoonwellData(); // Общий статус
    await getMoonwellPositions(); // Детальный список позиций

    // Получаем слепок всех балансов на кошельке
    const walletBalances = await getWalletBalances();
    console.log(walletBalances);
    //await getJumperQuote();
    //await get0xQuoteV2("1.0");
    if(CONFIG.CHAIN === 'OPT') {
        //await borrowMoonwellAsset('OP', 300);


         await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
         await getUniswapPoolPrice(POOLS.OPT.EthOp005, provider);
         await estimatePriceImpact(provider, 300, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
         await estimatePriceImpact(provider, 300, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
    }
}

main();

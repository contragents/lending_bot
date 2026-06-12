import {CONFIG, getEnv, LENDING, POOLS, type WalletBalances} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';


import {estimatePriceImpact, wallet} from './utils.js';
import {getJumperQuote, get0xQuoteV2, getUniswapPoolPrice, getWalletBalances} from './utils.js';
import {provider} from "./config.js";
import {
    getMoonwellData,
    getMoonwellPositions,
    borrowMoonwellAsset,
    supplyMoonwellAsset,
    repayMoonwellAsset
} from './moonwellUtils.js';

async function main() {


    await getMoonwellData(); // Общий статус
    //await getMoonwellPositions(); // Детальный список позиций


    // Получаем слепок всех балансов на кошельке
    const walletBalances = await getWalletBalances() as WalletBalances;
    console.log(walletBalances);
    //await getJumperQuote();
    //await get0xQuoteV2("1.0");
    if (CONFIG.CHAIN === 'OPT') {
        const borrowAmount = 120;
        console.log(await borrowMoonwellAsset('OP', borrowAmount)); // Берем займ - проверено
        console.log(await repayMoonwellAsset('OP', borrowAmount)); // Отдаем займ - тест

        //await supplyMoonwellAsset('ETH', (walletBalances['ETH']?.human ?? 0) - 0.004); // Вносим залог - проверено

        await getMoonwellPositions(); // Детальный список позиций

        //return;

        await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
        await getUniswapPoolPrice(POOLS.OPT.EthOp005, provider);
        await estimatePriceImpact(provider, borrowAmount, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
        await estimatePriceImpact(provider, borrowAmount, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
    }
}

main();

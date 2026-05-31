import {CONFIG, getEnv, LENDING, POOLS, type WalletBalances} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';



import {estimatePriceImpact, wallet} from './utils.js';
import {getJumperQuote, get0xQuoteV2, getUniswapPoolPrice, getWalletBalances} from './utils.js';
import {provider} from "./config.js";
import {getMoonwellData, getMoonwellPositions, borrowMoonwellAsset, supplyMoonwellAsset} from './moonwellUtils.js';

async function main() {


    await getMoonwellData(); // Общий статус


    // Получаем слепок всех балансов на кошельке
    const walletBalances = await getWalletBalances() as WalletBalances;
    console.log(walletBalances);
    //await getJumperQuote();
    //await get0xQuoteV2("1.0");
    if(CONFIG.CHAIN === 'OPT') {
        // await borrowMoonwellAsset('OP', 300); // Берем займ - проверено
        if(await supplyMoonwellAsset('ETH', (walletBalances['ETH']?.human ?? 0) - 0.004)) {
            await getMoonwellPositions(); // Детальный список позиций
        }

        return;

         await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
         await getUniswapPoolPrice(POOLS.OPT.EthOp005, provider);
         await estimatePriceImpact(provider, 300, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
         await estimatePriceImpact(provider, 300, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
    }
}

main();

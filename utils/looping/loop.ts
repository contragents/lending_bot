import {getUniswapPoolPrice, getWalletBalances, sleep} from "../utils.js";
import {POOLS, provider, type WalletBalances} from "../../config.js";
import {borrowMoonwellAsset} from "../moonwell/borrowAsset.js";
import {swapToEth} from "../uniswap/swap.js";
import {supplyMoonwellAsset} from "../moonwell/supplyMoonwellAsset.js";

export async function loop(borrowAmount: number) {
    let walletBalances = await getWalletBalances() as WalletBalances;
    let numTry = 0;

    // Заходим в цикл займ-обмен только если эфира мало, иначе сразу супплаим весь эфир
    if (walletBalances.ETH.human < 0.01) {
        if (walletBalances.OP.human < borrowAmount) {
            // Берем займ - проверено
            console.log(await borrowMoonwellAsset('OP', borrowAmount));
        }

        const hasEth = walletBalances.ETH.human;

        while (true) {
            numTry++;
            await sleep(5000);
            try {
                walletBalances = await getWalletBalances() as WalletBalances;

                if (walletBalances.ETH.human > hasEth) {
                    console.log('ETH от обмена поступил на баланс кошелька');

                    break;
                }

                if (walletBalances.OP.human < borrowAmount) {
                    console.log("Ожидается поступление OP на баланс кошелька....");

                    if (numTry < 5) continue; else break;
                }

                let quote = await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
                quote = 1 / quote;

                console.log(await swapToEth("OP", walletBalances.OP.human, quote));
            } catch (e) {
                console.log(e);
            }
        }
    }

    let status = 'waitForEth';
    numTry = 0;

    while (true) {
        numTry++;
        if (numTry > 5) break;

        await sleep(5000);

        try {
            walletBalances = await getWalletBalances() as WalletBalances;
            if (walletBalances.ETH.human > 0.01) {
                status = 'trySupply';
                await supplyMoonwellAsset('ETH', (walletBalances['ETH']?.human ?? 0) - 0.004);

                break;
            }

            // Проверяем, вдруг транзакция supply выполнилась с задержкой
            if (status === 'trySupply' && walletBalances.ETH.human < 0.01) {
                break;
            }
        } catch (e) {
            console.log(e);
        }
    }
}
import {getUniswapPoolPrice, getWalletBalances, sleep} from "../utils.js";
import {POOLS, provider, type WalletBalances} from "../../config.js";
import {withdrawMoonwellAsset} from "../moonwell/withdrawMoonwellAsset.js";
import {swapEthToOp} from "../uniswap/swap.js";
import {repayMoonwellAsset} from "../moonwell/repayAsset.js";

export async function deLoop(supplyAmount: number) {
    let walletBalances = await getWalletBalances() as WalletBalances;
    let numTry = 0;

    // Заходим в цикл withdraw-обмен только если OP мало, иначе сразу супплаим весь эфир
    if (walletBalances.OP.human < supplyAmount * 0.9) {
        let quote = await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);

        // Проверяем, что ETH в кошельке не остался от прошлого прогона метода
        if (walletBalances.ETH.human < 0.01) {
            console.log(await withdrawMoonwellAsset('ETH', supplyAmount / quote));
        }

        const hasOp = walletBalances.OP.human;

        while (true) {
            numTry++;
            await sleep(5000);
            try {
                walletBalances = await getWalletBalances() as WalletBalances;

                if (walletBalances.OP.human > hasOp) {
                    console.log('OP от обмена поступил на баланс кошелька');

                    break;
                }

                if (walletBalances.ETH.human < supplyAmount / quote * 0.9) {
                    console.log("Ожидается поступление ETH на баланс кошелька....");

                    if (numTry < 5) continue; else break;
                }

                console.log(await swapEthToOp("OP", walletBalances.ETH.human - 0.004, quote));
            } catch (e) {
                console.log(e);
            }
        }
    }

    let status = 'waitForOp';
    numTry = 0;
    while (true) {
        numTry++;
        await sleep(5000);

        try {
            walletBalances = await getWalletBalances() as WalletBalances;
            if (walletBalances.OP.human > supplyAmount * 0.9) {
                status = 'tryRepay';
                console.log(await repayMoonwellAsset('OP', walletBalances.OP.human));

                break;
            }

            // Проверяем, вдруг транзакция repay выполнилась с задержкой
            if (status === 'tryRepay' && walletBalances.OP.human < 10) {
                break;
            }

            if (numTry > 5) break;
        } catch (e) {
            console.log(e);
        }
    }
}
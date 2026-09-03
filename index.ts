import {CONFIG, LENDING, POOLS, type WalletBalances} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers} from 'ethers';


import {estimatePriceImpact, sleep} from './utils/utils.js';
import {getJumperQuote, get0xQuoteV2, getUniswapPoolPrice, getWalletBalances} from './utils/utils.js';
import {provider} from "./config.js";
import {repayMoonwellAsset} from "./utils/moonwell/repayAsset.js";
import {borrowMoonwellAsset} from "./utils/moonwell/borrowAsset.js";
import {getMoonwellPositions} from "./utils/moonwell/getMoonwellPositions.js";
import {getMoonwellData} from "./utils/moonwell/getMoonwellData.js";
import {supplyMoonwellAsset} from "./utils/moonwell/supplyMoonwellAsset.js";
import {wallet} from "./utils/loadWallet.js";
import {withdrawMoonwellAsset} from "./utils/moonwell/withdrawMoonwellAsset.js";
import {swapEthToOp, swapToEth} from "./utils/uniswap/swap.js";
import {fetchLendingInstruction} from "./utils/invest_legal/recommend.js";


async function main() {
    let borrowAmount = 0; // подлупка в токенах займа (OP)
    let supplyAmount = 0; // разлупка в токенах займа (OP)
    let borrowedToken = 'OP';
    while (true) {
        try {
            if(!await getMoonwellPositions()) {
                continue;
            }

            // Получаем слепок всех балансов на кошельке
            let walletBalances = await getWalletBalances() as WalletBalances;
            console.log(walletBalances);

            const data = await fetchLendingInstruction(4);

            if (data.deloop) {
                console.log("Получены данные для де-лупа:", data.deloop);

                const entries = Object.entries(data.deloop);

                if (entries.length > 0) {
                    [borrowedToken, supplyAmount] = entries[0]!;
                }
            } else if (data.loop) {
                console.log("Получены данные для лупа:", data.loop);
                const entries = Object.entries(data.loop);

                if (entries.length > 0) {
                    [borrowedToken, borrowAmount] = entries[0]!;
                }
            } else {
                console.log("Данные отсутствуют или произошла ошибка (вернулся пустой объект)");
            }

            console.log(`Имя токена: ${borrowedToken}`);
            console.log(`Количество: ${Math.max(supplyAmount, borrowAmount)}`);

            if (CONFIG.CHAIN === 'OPT') {
                if (wallet) {
                    if (borrowAmount) {
                        await loop(borrowAmount);
                    } else if (supplyAmount) {
                        await deLoop(supplyAmount);
                    }
                }
            }

        } catch (e) {
            console.log(e);
        } finally {
            borrowAmount = 0;
            supplyAmount = 0;
            await sleep(5000);
        }
    }

    return;
    // await getMoonwellData(); // Общий статус, сколько можно занять в USD
    //await getJumperQuote();
    //await get0xQuoteV2("1.0");
    //await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
    //await getUniswapPoolPrice(POOLS.OPT.EthOp005, provider);
    //await estimatePriceImpact(provider, borrowAmount, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
    //await estimatePriceImpact(provider, borrowAmount, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
}

async function deLoop(supplyAmount: number) {
    let walletBalances = await getWalletBalances() as WalletBalances;

    // Заходим в цикл withdraw-обмен только если OP мало, иначе сразу супплаим весь эфир
    if (walletBalances.OP.human < supplyAmount * 0.9) {
        let quote = await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);

        // Проверяем, что ETH в кошельке не остался от прошлого прогона метода
        if (walletBalances.ETH.human < 0.01) {
            console.log(await withdrawMoonwellAsset('ETH', supplyAmount / quote));
        }

        const hasOp = walletBalances.OP.human;

        while (true) {
            await sleep(5000);
            try {
                walletBalances = await getWalletBalances() as WalletBalances;

                if (walletBalances.OP.human > hasOp) {
                    console.log('OP от обмена поступил на баланс кошелька');

                    break;
                }

                if (walletBalances.ETH.human < supplyAmount / quote * 0.9) {
                    console.log("Ожидается поступление ETH на баланс кошелька....");

                    continue;
                }

                console.log(await swapEthToOp("OP", walletBalances.ETH.human - 0.004, quote));
            } catch (e) {
                console.log(e);
            }
        }
    }

    let status = 'waitForOp';
    while (true) {
        await sleep(5000);

        try {
            walletBalances = await getWalletBalances() as WalletBalances;
            if (walletBalances.OP.human > supplyAmount * 0.9) {
                status = 'tryRepay';
                console.log(await repayMoonwellAsset('OP', walletBalances.OP.human));

                break;
            }

            // Проверяем, вдруг транзакция repay выполнилась с задержкой
            if (status === 'tryRepay' && walletBalances.OP.human < 50) {
                break;
            }
        } catch (e) {
            console.log(e);
        }
    }
}

async function loop(borrowAmount: number) {
    let walletBalances = await getWalletBalances() as WalletBalances;

    // Заходим в цикл займ-обмен только если эфира мало, иначе сразу супплаим весь эфир
    if (walletBalances.ETH.human < 0.01) {
        if (walletBalances.OP.human < borrowAmount) {
            // Берем займ - проверено
            console.log(await borrowMoonwellAsset('OP', borrowAmount));
        }

        const hasEth = walletBalances.ETH.human;

        while (true) {
            await sleep(5000);
            try {
                walletBalances = await getWalletBalances() as WalletBalances;

                if (walletBalances.ETH.human > hasEth) {
                    console.log('ETH от обмена поступил на баланс кошелька');

                    break;
                }

                if (walletBalances.OP.human < borrowAmount) {
                    console.log("Ожидается поступление OP на баланс кошелька....");

                    continue;
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
    while (true) {
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

main();

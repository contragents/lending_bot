import {CONFIG, type WalletBalances} from './config.js'; // Важно: в ESM нужно указывать .js
import {getWalletBalances, sleep} from './utils/utils.js';
import {getMoonwellPositions} from "./utils/moonwell/getMoonwellPositions.js";
import {wallet} from "./utils/loadWallet.js";
import {fetchLendingInstruction} from "./utils/invest_legal/recommend.js";
import {deLoop} from "./utils/looping/deLoop.js";
import {loop} from "./utils/looping/loop.js";

// Глобальный перехватчик неисполненных промисов
process.on('unhandledRejection', (reason: any, promise) => {
    // Проверяем, что это именно таймаут от Ethers.js
    if (reason && reason.code === 'TIMEOUT') {
        console.warn('⚠️ [Глобальный перехват] RPC-нода зависла по таймауту в фоновом запросе. Игнорируем, бот продолжает работу.');

        return; // Просто гасим ошибку, не давая процессу упасть
    }

    // Если это какая-то другая серьезная ошибка, лучше вывести её в логи
    console.error('❌ Необработанная ошибка (Unhandled Rejection):', reason);
});

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
            await sleep(30000);
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

main();

import {BASE_CHAIN, type ChainType, CONFIG, getEnv, HL_CHAIN, OPT_CHAIN, type WalletBalances} from './config.js'; // Важно: в ESM нужно указывать .js
import {getWalletBalances, sleep} from './utils/utils.js';
import {initializeWallet, wallets} from "./utils/loadWallet.js";
import {MoonwellPosition} from "./classes/MoonwellPosition.js";
import {MorphoPosition} from "./classes/MorphoPosition.js";
import {HLPosition} from "./classes/HLPosition.js";
import {ethers, FetchRequest} from "ethers";
import type {Position} from "./classes/Position.js";

const providers = new Map<ChainType, ethers.JsonRpcProvider>();
for (const chainName of [OPT_CHAIN, BASE_CHAIN] as const) {
    const connection = new FetchRequest(CONFIG.NETWORKS[chainName].RPC_URL);
    connection.timeout = 5000;
    providers.set(
        chainName,
        new ethers.JsonRpcProvider(connection, undefined, {batchMaxCount: 1})
    );
}
providers.set(HL_CHAIN, new ethers.JsonRpcProvider());

function getProvider(chain: ChainType): ethers.JsonRpcProvider {
    const configuredProvider = providers.get(chain);
    if (!configuredProvider) {
        throw new Error(`RPC provider is not configured for chain ${chain}`);
    }

    return configuredProvider;
}

const chain: ChainType = OPT_CHAIN;
const activeProvider = getProvider(chain);
await initializeWallet(providers);

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
    const moonwellPosition = new MoonwellPosition(OPT_CHAIN, getProvider(OPT_CHAIN));
    const morphoPosition = new MorphoPosition(BASE_CHAIN, getProvider(BASE_CHAIN));
    const hlPosition = new HLPosition(HL_CHAIN, getProvider(HL_CHAIN));

    const positions: Record<ChainType, Position[]> = {
        OPT: [
             // moonwellPosition // Позиция закрыта
        ],
        BASE: [
             morphoPosition // Пока не анализируем
        ],
        HL: [hlPosition]
    };

    let borrowAmount = 0; // подлупка в токенах займа (OP)
    let supplyAmount = 0; // разлупка в токенах займа (OP)
    let borrowedToken = 'OP';

    const maxCycles = 100;
    let cycles = 0;

    while (true) {
        for (const [chainKey, positionList] of Object.entries(positions)) {
            const chain = chainKey as ChainType;
            console.log(`\n🌐 Обработка сети: ${chain} (Всего позиций: ${positionList.length})`);
            // Перебираем массив объектов позиций для текущей сети
            for (const position of positionList) {
                try {
                    if (!await position.getPosition() || !await position.reportPosition()) {
                        continue;
                    }

                    const data = await position.getRecommend();
                    console.log(data, data.loop ?? {}, data.deloop ?? {});

                    // Получаем слепок всех балансов на кошельке
                    if (chain !== HL_CHAIN) {
                        let walletBalances = await getWalletBalances(chain, getProvider(chain)) as WalletBalances;
                        console.log(walletBalances);
                    }

                    if (data.deloop) {
                        console.log("Получены данные для де-лупа:", data.deloop);

                        const entries = Object.entries(data.deloop.borrow ?? {});

                        if (entries.length > 0) {
                            [borrowedToken, supplyAmount] = entries[0]!;
                        } else if (data.deloop.supply) {
                            supplyAmount = 1; // Фейковое значение для HL
                        }
                    } else if (data.loop) {
                        console.log("Получены данные для лупа:", data.loop);
                        const entries = Object.entries(data.loop.borrow ?? {});

                        if (entries.length > 0) {
                            [borrowedToken, borrowAmount] = entries[0]!;
                        } else if (data.loop.supply) {
                            borrowAmount = 1; // Фейковое значение для HL
                        }
                    } else {
                        console.log("Данные отсутствуют или произошла ошибка (вернулся пустой объект)");
                    }

                    console.log(`Имя токена: ${borrowedToken}`);
                    console.log(`Количество: ${Math.max(supplyAmount, borrowAmount)}`);


                    if (borrowAmount && data.loop) {
                        await position.loop(borrowAmount, data.loop);
                    } else if (supplyAmount && data.deloop) {
                        await position.deLoop(supplyAmount, data.deloop);
                    }


                } catch (e) {
                    console.log(e);
                }

                cycles++;
                borrowAmount = 0;
                supplyAmount = 0;
            }
        }

        if (getEnv('ENV') !== 'DEV' && cycles >= maxCycles) break;
        await sleep(30000);
    }

    return;
    // await getMoonwellData(); // Общий статус, сколько можно занять в USD
    //await getJumperQuote();
    //await get0xQuoteV2("1.0");
    //await getUniswapPoolPrice(chain, POOLS.OPT.EthOp03, activeProvider);
    //await getUniswapPoolPrice(chain, POOLS.OPT.EthOp005, activeProvider);
    //await estimatePriceImpact(activeProvider, borrowAmount, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
    //await estimatePriceImpact(activeProvider, borrowAmount, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
}

main();

import {
    BUY_TOKEN,
    CONFIG,
    getEnv,
    POOLS,
    provider,
    SELL_TOKEN,
    type SupportedToken,
    type WalletBalances,
    WATCH_ADDRESS
} from "./config.js";
import {ethers, formatUnits} from 'ethers';

import * as LIFI from '@lifi/sdk';
import readline from 'readline/promises';

export const wallet = await loadWallet(provider);
const currentNetwork = CONFIG.NETWORKS[CONFIG.CHAIN];
const sellTokenAddr = currentNetwork.TOKENS[SELL_TOKEN]; // ETH
const buyTokenAddr = currentNetwork.TOKENS[BUY_TOKEN];

/**
 * Универсальная обертка для повторных попыток выполнения асинхронных функций
 * @param fn - Функция, которую нужно выполнить
 * @param retries - Количество попыток (по умолчанию 3)
 * @param delay - Начальная задержка в мс (по умолчанию 1000)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    retries: number = 3,
    delay: number = 1000
): Promise<T> {
    try {
        return await fn();
    } catch (error: any) {
        // Проверяем, является ли ошибка временным сбоем (таймаут, лимиты, сетевой сбой)
        const isTimeout = error.message?.includes('timeout') || error.code === 'TIMEOUT';
        const isRateLimit = error.info?.error?.message?.includes('tier') || error.status === 429;

        if (retries > 0 && (isTimeout || isRateLimit || error.code === 'CALL_EXCEPTION')) {
            console.log(`⚠️ Сетевая задержка или лимит RPC. Повтор через ${delay}ms... (Попыток осталось: ${retries})`);

            await new Promise(res => setTimeout(res, delay));

            // Экспоненциальное увеличение задержки (1s -> 2s -> 4s)
            return withRetry(fn, retries - 1, delay * 2);
        }

        // Если попытки кончились или ошибка критическая — выбрасываем её дальше
        throw error;
    }
}

// Инициализация LI.FI SDK
LIFI.createConfig({
    integrator: 'lifi',
    // здесь можно добавить настройки чейнов, если нужно
});

export async function getJumperQuote() {
    console.log(`--- JUMPER (LIFI) Quote (${CONFIG.CHAIN}) ---`);
    try {
        const quoteRequest = {
            fromChain: CONFIG.NETWORKS[CONFIG.CHAIN].ID,
            toChain: CONFIG.NETWORKS[CONFIG.CHAIN].ID,
            fromToken: sellTokenAddr!,
            toToken: buyTokenAddr!,
            fromAmount: '1000000000000000000', // 1 ETH
            fromAddress: WATCH_ADDRESS,
            slippage: 0.005, // 0.5%
            order: 'CHEAPEST' as const, // Принудительно искать самый дешевый вариант
            insurance: false,  // Отключить страховку, если она включена по умолчанию
        };

        const quote = await withRetry(() => LIFI.getQuote(quoteRequest));
        // Для USDC указываем 6 знаков
        const formattedAmount = formatUnits(quote.estimate.toAmount, CONFIG.TOKEN_DECIMALS[BUY_TOKEN]);
        const formattedAmountMin = formatUnits(quote.estimate.toAmountMin, CONFIG.TOKEN_DECIMALS[BUY_TOKEN]);

        //console.dir(quote.estimate, {depth: null});

        console.log(`Лучший маршрут: ${quote.tool}`);
        console.log(`Вы получите (LIFI): ${formattedAmount}/${formattedAmountMin} ${BUY_TOKEN}`);
    } catch (error) {
        console.error('Ошибка получения котировки:', error);
    }
}


export async function get0xQuoteV2(amountInEth: string) {
    console.log(`--- 0x API v2 Quote (CONFIG.CHAIN) ---`);

    //const currentNetwork = CONFIG.NETWORKS[CONFIG.CHAIN];
    const amountInWei = ethers.parseEther(amountInEth).toString();

    // Параметры согласно документации v2
    // @ts-ignore
    const params = new URLSearchParams({
        chainId: CONFIG.NETWORKS[CONFIG.CHAIN].ID, // Optimism
        sellToken: sellTokenAddr, // ETH
        buyToken: buyTokenAddr,
        sellAmount: amountInWei,
        taker: WATCH_ADDRESS, // Адрес того, кто будет делать обмен
        slippagePercentage: CONFIG.SLIPPAGE.toString(),
    });

    try {
        const response = await fetch(
            `https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`,
            {
                headers: {
                    "0x-api-key": CONFIG.ZEROX_API_KEY,
                    "0x-version": "v2", // Обязательно для нового API
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.ok) {
            // В v2 ошибки часто возвращаются в формате JSON с полем "reason"
            const errorData = await response.json();
            console.error('Детали ошибки 0x:', errorData);

            return;
        }

        const data = await response.json() as any;

        // В v2 структура ответа может отличаться: ищите buyAmount в объекте
        console.log(`Вы получите (0x): ${ethers.formatUnits(data.buyAmount, CONFIG.TOKEN_DECIMALS[BUY_TOKEN])}/${ethers.formatUnits(data.minBuyAmount, CONFIG.TOKEN_DECIMALS[BUY_TOKEN])} ${BUY_TOKEN}`);

        // console.dir(data, {depth: null});

        return data;

    } catch (error: any) {
        // Если fetch failed, смотрим причину (cause)
        console.error('Ошибка сети:', error.message);
        if (error.cause) console.error('Причина:', error.cause);
    }
}

export async function getUniswapPoolPrice(pool: string, provider: ethers.JsonRpcProvider) {
    const poolFee = pool === POOLS.OPT.EthOp005 ? "0.05" : "0.3";

    const poolContract = new ethers.Contract(pool, CONFIG.ABI.UNISWAP, provider) as any;

    // Получаем текущий слепок пула (без затрат газа)
    const [sqrtPriceX96, tick] = await poolContract.slot0();

    // Математика Uniswap V3 для расчета цены из tick
    // Цена ETH относительно OP = 1.0001 ^ tick
    const priceETHinOP = Math.pow(1.0001, Number(tick));

    console.log(`--- Uniswap V3 Pool (ETH/OP ${poolFee}) ---`);
    console.log(`Текущая цена 1 ETH = ${priceETHinOP.toFixed(6)} OP`);

    return priceETHinOP;
}

export async function loadWallet(provider: ethers.Provider) {
    const keystoreJson = getEnv('ENCRYPTED_KEY');
    let password = getEnv('KEY_PASSWORD');
    if (!password || password === '0') {
        // Запрашиваем пароль в консоли (безопаснее, чем хранить в .env)
        const rl = readline.createInterface({input: process.stdin, output: process.stdout});
        password = await rl.question('Введите пароль от кошелька: ');
        rl.close();
    }

    try {
        console.log("Расшифровка...");
        // Восстанавливаем кошелек
        const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson!, password);

        return wallet.connect(provider);
    } catch (e) {
        console.log("Неверный пароль!");

        return;
    }
}

export async function estimatePriceImpact(
    provider: ethers.JsonRpcProvider,
    amountInHuman: number, // Сколько OP мы хотим поменять (например, 1000)
    poolAddress: string,
    abi: string[],
) {
    const poolContract = new ethers.Contract(poolAddress, abi, provider) as any;

    // 1. ПОЛУЧЕНИЕ ИСХОДНЫХ ДАННЫХ ПУЛА
    const [sqrtPriceX96] = await poolContract.slot0();
    const L = BigInt(await poolContract.liquidity());
    const poolFee = await poolContract.fee();
    const Q96 = BigInt(2) ** BigInt(96);

    const amountInWei = ethers.parseUnits(amountInHuman.toString(), 18);

    const l1GasCostWei = await l1FeeEstimated(provider);

    // Считаем стандартный L2 Execution Fee
    const feeData = await provider.getFeeData();
    const l2GasPrice = feeData.gasPrice ?? BigInt(0);
    const L2_GAS_LIMIT = BigInt(150000); // Оценка лимита газа исполнения на L2
    const l2GasCostWei = l2GasPrice * L2_GAS_LIMIT;

    // Суммарный газ (L1 + L2)
    const totalGasCostWei = l1GasCostWei + l2GasCostWei;
    const totalGasCostETH = Number(ethers.formatUnits(totalGasCostWei, 18));

    // 3. МАТЕМАТИКА СВОПА И ПОТЕРЬ
    const feePercent = Number(poolFee) / 10000;
    const feeAmountWei = (amountInWei * BigInt(poolFee)) / BigInt(1000000);
    const amountAfterFeeWei = amountInWei - feeAmountWei;
    const feeAmountHuman = Number(ethers.formatUnits(feeAmountWei, 18));

    const sqrtP_start = BigInt(sqrtPriceX96);
    const ratio_start = (Number(sqrtP_start) / Number(Q96)) ** 2;
    const currentPriceOPinETH = 1 / ratio_start;

    // Идеальный результат без издержек
    const idealAmountOutETH = amountInHuman * currentPriceOPinETH;

    // Переводим стоимость газа из ETH в OP по текущему курсу для сложения
    const gasCostOP = totalGasCostETH / currentPriceOPinETH;

    // Рассчитываем движение цены
    const sqrtP_end = sqrtP_start + ((amountAfterFeeWei * Q96) / L);
    const numerator = L * Q96 * (sqrtP_end - sqrtP_start);
    const denominator = sqrtP_end * sqrtP_start;
    const realAmountOutWei = numerator / denominator;
    const realAmountOutETH = Number(ethers.formatUnits(realAmountOutWei, 18));

    // Итоговый чистый профит на кошельке
    const netAmountOutETH = realAmountOutETH - totalGasCostETH;

    // Финансовые потери пула
    const tradingLossETH = idealAmountOutETH - realAmountOutETH;
    const tradingLossInOP = tradingLossETH / currentPriceOPinETH;
    const priceImpactInOP = tradingLossInOP - feeAmountHuman;

    // ИТОГО (Пул + Реальный Газ L1 + L2)
    const totalLossInOP = tradingLossInOP + gasCostOP;
    const totalLossPercent = (totalLossInOP / amountInHuman) * 100;

    const priceImpactPercent = (priceImpactInOP / amountInHuman) * 100;
    const gasLossPercent = (gasCostOP / amountInHuman) * 100;

    console.log(`--- Анализ с точным газом Optimism L1+L2 (${amountInHuman} OP, Пул ${feePercent}%) ---`);
    console.log(`Идеальный выход (без потерь): ${idealAmountOutETH.toFixed(6)} ETH`);
    console.log(`Реальный выход из пула:      ${realAmountOutETH.toFixed(6)} ETH`);
    console.log(`Чистый результат на выходе:  ${netAmountOutETH.toFixed(6)} ETH`);

    console.log(`\n[ Реальная стоимость газа ]:`);
    console.log(`- L1 Data Fee (Ethereum):    ${Number(ethers.formatUnits(l1GasCostWei, 18)).toFixed(18)} ETH`);
    console.log(`- L2 Execution Fee:          ${Number(ethers.formatUnits(l2GasCostWei, 18)).toFixed(18)} ETH`);
    console.log(`- Всего за транзакцию:       ${totalGasCostETH.toFixed(18)} ETH (~${gasCostOP.toFixed(18)} OP)`);

    console.log(`\n[ Абсолютные потери в OP ]:`);
    console.log(`- Комиссия пула:             ${feeAmountHuman.toFixed(4)} OP`);
    console.log(`- Потери от Price Impact:    ${priceImpactInOP.toFixed(4)} OP`);
    console.log(`- Потери на газ:             ${gasCostOP.toFixed(18)} OP`);
    console.log(`- ИТОГО ПОТЕРЯНО:            ${totalLossInOP.toFixed(4)} OP`);

    console.log(`\n[ Процентные потери от вносимых OP ]:`);
    console.log(`- Процент комиссии пула:     ${feePercent.toFixed(4)}%`);
    console.log(`- Процент Price Impact:      ${priceImpactPercent.toFixed(4)}%`);
    console.log(`- Процент затрат на газ:     ${gasLossPercent.toFixed(6)}%`);
    console.log(`- ОБЩИЙ ПРОЦЕНТ ПОТЕРЬ:      ${totalLossPercent.toFixed(4)}%`);

    return {realAmountOutETH, netAmountOutETH, totalLossPercent};
}

async function l1FeeEstimated(provider: ethers.JsonRpcProvider) {
    const oracleContract = new ethers.Contract(POOLS.OPT.OracleAddress, CONFIG.ABI.ORACLE, provider) as any;

    // 2. СОВРЕМЕННЫЙ АВТОНОМНЫЙ РАСЧЕТ ГАЗА OPTIMISM (L1 Ecotone + L2)
    const l1BaseFee = await oracleContract.l1BaseFee();
    const blobBaseFee = await oracleContract.blobBaseFee();
    const baseFeeScalar = BigInt(await oracleContract.baseFeeScalar());
    const blobBaseFeeScalar = BigInt(await oracleContract.blobBaseFeeScalar());
    const oracleDecimals = await oracleContract.decimals(); // Обычно 6

    // Приблизительный объем calldata газа для Swap-транзакции exactInputSingle (~300 байт)
    const calldataGas = BigInt(4200 * 2); // берем с 2х запасом

    // Актуальная формула расчета L1 Data Fee (Bedrock/Ecotone с BlobSpace)
    // Формула: calldataGas * (16 * l1BaseFee * baseFeeScalar + blobBaseFee * blobBaseFeeScalar) / (16 * 10^decimals)
    const scaledBaseFee = BigInt(16) * l1BaseFee * baseFeeScalar;
    const scaledBlobBaseFee = blobBaseFee * blobBaseFeeScalar;

    return (calldataGas * (scaledBaseFee + scaledBlobBaseFee)) / (BigInt(16) * (BigInt(10) ** oracleDecimals));
}

export async function getWalletBalances(): Promise<WalletBalances> {
    console.log(`\n--- Проверка балансов кошелька (${CONFIG.CHAIN}) ---`);
    console.log(`Адрес: ${WATCH_ADDRESS}`);

    const balances: WalletBalances = {};

    try {
        // 1. СНАЧАЛА ПОЛУЧАЕМ БАЛАНС НАТИВНОГО ETH
        // Нативный баланс запрашивается напрямую через провайдер, а не через контракт
        const ethBalanceWei = await withRetry<bigint>(() => provider.getBalance(WATCH_ADDRESS));
        const ethBalanceHuman = Number(formatUnits(ethBalanceWei, 18));

        balances['ETH'] = {
            wei: ethBalanceWei,
            human: ethBalanceHuman
        };
        console.log(`💰 ETH (Нативный) -> ${ethBalanceHuman.toFixed(6)} ETH`);

        // 2. ПОЛУЧАЕМ БАЛАНСЫ ОСТАЛЬНЫХ ERC-20 ТОКЕНОВ ИЗ КОНФИГА
        // Перебираем токены, которые описаны в CONFIG.TOKEN_DECIMALS (например, USDC, OP, WETH, cbBTC)
        for (const tokenSymbol in currentNetwork.TOKENS) {
            console.log(tokenSymbol);
            // Пропускаем ETH, так как нативный баланс мы уже получили выше
            if (tokenSymbol === 'ETH') continue;

            // Берем адрес контракта токена из конфигурации вашей текущей сети
            if (!(tokenSymbol in currentNetwork.TOKENS)) {
                console.log(`⚠️ Токен ${tokenSymbol} не описан в конфигурации TOKENS для этой сети.`);

                continue;
            }

            const tokenAddress = currentNetwork.TOKENS[tokenSymbol as keyof typeof currentNetwork.TOKENS];

            // ЗДЕСЬ ДОБАВЛЯЕМ ПРОВЕРКУ-ЗАЩИТУ:
            if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
                continue; // Пропускаем токен, если его адреса нет в этой сети
            }
            const tokenContract = new ethers.Contract(tokenAddress, CONFIG.ABI.ERC20_BALANCE_ABI, provider);
            // Запрашиваем баланс токена на кошельке
            //const balanceWei = await withRetry<bigint>(() => (tokenContract as any).balanceOf(WATCH_ADDRESS));
            const balanceWei = await getTokenBalanceWei(tokenSymbol as SupportedToken);
            // Используем decimals из глобального конфига
            const decimals = CONFIG.TOKEN_DECIMALS[tokenSymbol] ?? CONFIG.TOKEN_DECIMALS.default;
            const balanceHuman = Number(formatUnits(balanceWei, decimals));

            balances[tokenSymbol] = {
                wei: balanceWei,
                human: balanceHuman
            };

            // Выводим в консоль только ненулевые балансы, чтобы не спамить
            if (balanceHuman > 0) {
                console.log(`🪙 ${tokenSymbol} (ERC-20)   -> ${balanceHuman.toFixed(6)} ${tokenSymbol}`);
            }
        }

        return balances;
    } catch (err: any) {
        console.error("Ошибка при получении балансов кошелька:", err.message);
        throw err;
    }
}

async function getTokenBalanceWei(tokenSymbol: SupportedToken) {
    const tokenAddress = currentNetwork.TOKENS[tokenSymbol as keyof typeof currentNetwork.TOKENS];

    // ДОБАВЛЯЕМ ПРАВИЛЬНУЮ ПРОВЕРКУ-ЗАЩИТУ ДЛЯ ФУНКЦИИ:
    if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
        console.warn(`Токен ${tokenSymbol} не найден в текущей сети.`);

        return 0n; // Возвращаем нулевой баланс (BigInt), если адреса нет в сети
    }

    const tokenContract = new ethers.Contract(tokenAddress, CONFIG.ABI.ERC20_BALANCE_ABI, provider);
    // Запрашиваем баланс токена на кошельке
    return await withRetry<bigint>(() => (tokenContract as any).balanceOf(WATCH_ADDRESS));
}

async function getTokenBalanceHuman(tokenSymbol: SupportedToken) {

    const balanceWei = await getTokenBalanceWei(tokenSymbol);
    // Используем decimals из глобального конфига
    const decimals = CONFIG.TOKEN_DECIMALS[tokenSymbol] ?? CONFIG.TOKEN_DECIMALS.default;

    return Number(formatUnits(balanceWei, decimals));
}
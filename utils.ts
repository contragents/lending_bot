import {CONFIG, POOLS} from "./config.js";
import {formatUnits} from 'ethers';
import {provider} from "./config.js";
import {WATCH_ADDRESS, SELL_TOKEN, BUY_TOKEN} from "./config.js";

const wallet = await loadWallet(provider);
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

export async function getMoonwellData() {
    console.log(`--- Moonwell Status (${CONFIG.CHAIN}) ---`);
    const comptroller = new ethers.Contract(
        CONFIG.NETWORKS[CONFIG.CHAIN!].MOONWELL.COMPTROLLER,
        CONFIG.ABI.MOONWELL,
        provider
    ) as any;

    // Возвращает: (error, liquidity, shortfall)
    // Liquidity > 0 означает, что заем безопасен. Shortfall > 0 означает риск ликвидации.
    const [error, liquidity, shortfall] = await withRetry<[bigint, bigint, bigint]>(
        () => comptroller.getAccountLiquidity(WATCH_ADDRESS)
    );

    console.log(`User: ${WATCH_ADDRESS}`);
    console.log(`Available Liquidity (в USD, 1e18): ${ethers.formatEther(liquidity)}`);
    console.log(`Shortfall (Риск): ${ethers.formatEther(shortfall)}`);
}

import {getEnv} from "./config.js";
import {LENDING} from "./config.js";
import type {SupportedToken} from "./config.js";

export async function getMoonwellPositions() {
    console.log(`--- Moonwell Assets & Liabilities (${CONFIG.CHAIN}) ---`);

    const comptroller = new ethers.Contract(
        currentNetwork.MOONWELL.COMPTROLLER,
        CONFIG.ABI.MOONWELL,
        provider
    );

    try {
        let borrows = {};
        let supplys = {};
        const tgId = getEnv('TG_ID');
        const baseUrl = "https://invest.legal/bot/lendingCorrection/";
        const url = new URL(baseUrl);
        const params = url.searchParams;
        params.set('tg_id', String(tgId));

        const chainConfig = LENDING[CONFIG.CHAIN!];
        const userConfig = chainConfig[tgId as keyof typeof chainConfig];
        // Используем с проверкой на случай, если пользователя нет в конфиге
        params.set('lending_id', String(userConfig?.ID ?? ''));

        // 1. Получаем адреса всех доступных рынков Moonwell в текущей сети
        const markets: string[] = await withRetry<string[]>(() => (comptroller as any).getAllMarkets());

        for (const mTokenAddress of markets) {
            // Создаем инстанс контракта конкретного рынка (например, mUSDC или mWETH)
            const mToken = new ethers.Contract(mTokenAddress, CONFIG.ABI.MOONWELL, provider);

            // 2. Получаем слепок аккаунта для этого рынка
            // Возвращает: (error, баланс_mToken, баланс_займа, внутренний_курс_обмена)
            const [error, mTokenBalance, borrowBalance, exchangeRate] =
                await withRetry<[bigint, bigint, bigint, bigint]>(() => (mToken as any).getAccountSnapshot(WATCH_ADDRESS));

            if (error !== 0n) continue;

            // Если балансы нулевые, пропускаем этот токен, чтобы не спамить в консоль
            if (mTokenBalance === 0n && borrowBalance === 0n) continue;

            // Получаем тикер рынка (например, "mUSDC")
            const mTokenSymbol = await withRetry<string>(() => (mToken as any).symbol());
            const underlyingSymbol = mTokenSymbol.substring(1); // Отсекаем первую 'm', получаем 'USDC'

            // 3. Расчет реального баланса актива (Supply Balance)
            // mTokens имеют свой баланс, который увеличивается за счет процентов.
            // Формула: (баланс_mToken * курс_обмена) / 1e18
            if (mTokenBalance > 0n) {
                const underlyingAmountWei = BigInt(mTokenBalance * exchangeRate) / ethers.parseEther("1");
                const formattedSupply = formatUnits(underlyingAmountWei, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                console.log(`🟢 Снабжение (Asset)  -> ${formattedSupply} ${underlyingSymbol}`);
                params.set('supply_' + userConfig.PAIR_IDS[underlyingSymbol as keyof typeof userConfig.PAIR_IDS], formattedSupply);
            }

            // 4. Расчет баланса долга (Borrow Balance)
            if (borrowBalance > 0n) {
                const formattedBorrow = formatUnits(borrowBalance, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                console.log(`🔴 Заем (Liability)   -> ${formattedBorrow} ${underlyingSymbol}`);
                params.set('borrow_' + userConfig.PAIR_IDS[underlyingSymbol as keyof typeof userConfig.PAIR_IDS], formattedBorrow);
            }
        }

        const response = await fetch(url.href);
        const text = await response.text(); // Читаем ответ как строку
        console.log(url.href, text); // Выведет чистый текст ответа
    } catch (err: any) {
        console.error("Ошибка при получении позиций Moonwell:", err.message);
    }
}

import * as LIFI from '@lifi/sdk';

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

export async function getUniswapPoolPrice(provider: ethers.JsonRpcProvider) {
    const poolEthOp005Address = "0xFC1f3296458F9b2a27a0B91dd7681C4020E09D05"; // Пул 0.05%
    const poolEthOp03Address = "0x68F5C0A2DE713a54991E01858Fd27a3832401849"; // Пул 0.3%

    const poolContract = new ethers.Contract(poolEthOp03Address, CONFIG.ABI.UNISWAP, provider) as any;

    // Получаем текущий слепок пула (без затрат газа)
    const [sqrtPriceX96, tick] = await poolContract.slot0();

    // Математика Uniswap V3 для расчета цены из tick
    // Цена ETH относительно OP = 1.0001 ^ tick
    const priceETHinOP = Math.pow(1.0001, Number(tick));

    console.log(`--- Uniswap V3 Pool (ETH/OP) ---`);
    console.log(`Текущая цена 1 ETH = ${priceETHinOP.toFixed(6)} OP`);

    return priceETHinOP;
}

import {ethers} from 'ethers';
import readline from 'readline/promises';
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

    return { realAmountOutETH, netAmountOutETH, totalLossPercent };
}

async function l1FeeEstimated(provider: ethers.JsonRpcProvider){
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

export interface MTokensCache {
    [symbol: string]: string;
}

// Вызывается один раз при старте бота
export async function initializeMTokensCache(provider: ethers.JsonRpcProvider): Promise<MTokensCache> {
    console.log(`--- Инициализация кэша mTokens Moonwell (${CONFIG.CHAIN}) ---`);

    const comptroller = new ethers.Contract(
        currentNetwork.MOONWELL.COMPTROLLER,
        CONFIG.ABI.MOONWELL,
        provider
    );

    const cache: MTokensCache = {};

    try {
        // Получаем все рынки из блокчейна один раз
        const markets: string[] = await withRetry<string[]>(() => (comptroller as any).getAllMarkets());

        for (const mTokenAddress of markets) {
            const mToken = new ethers.Contract(mTokenAddress, CONFIG.ABI.MOONWELL, provider);
            const mTokenSymbol = await withRetry<string>(() => (mToken as any).symbol());

            // Из 'mUSDC' получаем 'USDC', из 'mcbBTC' получаем 'cbBTC'
            const underlyingSymbol = mTokenSymbol.substring(1);

            cache[underlyingSymbol] = mTokenAddress;
        }

        console.log(`Кэш mTokens успешно собран:`, cache);
        return cache;
    } catch (err: any) {
        console.error("Критическая ошибка при инициализации кэша Moonwell:", err.message);
        throw err;
    }
}



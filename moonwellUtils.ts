import {CONFIG} from "./config.js";
import {formatUnits} from 'ethers';
import {provider} from "./config.js";
import {WATCH_ADDRESS} from "./config.js";
import {ethers} from "ethers";
import {withRetry} from "./utils.js";

const currentNetwork = CONFIG.NETWORKS[CONFIG.CHAIN];

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

import { MOONWELL_MARKETS } from "./config.js";
import type {SupportedToken} from "./config.js";
import {wallet} from "./utils.js";

export async function borrowMoonwellAsset(
    underlyingSymbol: SupportedToken,
    amountHuman: number
) {
    console.log(`--- Moonwell Borrow Initialization (${CONFIG.CHAIN}) ---`);

    // ------ Проверка баланса
    const debugComptroller = new ethers.Contract(
        currentNetwork.MOONWELL.COMPTROLLER,
        CONFIG.ABI.MOONWELL,
        wallet
    );

    console.log("--- Проверка кредитоспособности кошелька ---");

    // 1. Извлекаем адрес напрямую из константы по текущей сети
    const networkKey = CONFIG.CHAIN as keyof typeof MOONWELL_MARKETS;
    const mTokenAddress = (MOONWELL_MARKETS[networkKey].M_TOKENS as any)[underlyingSymbol];

    if (!mTokenAddress) {
        throw new Error(`Токен ${underlyingSymbol} не поддерживается в константах сети ${CONFIG.CHAIN}`);
    }

    // Расчет суммы займа в Wei
    const decimals = CONFIG.TOKEN_DECIMALS[underlyingSymbol];
    const borrowAmountWei = ethers.parseUnits(amountHuman.toString(), decimals);

    const mToken = new ethers.Contract(mTokenAddress, CONFIG.ABI.MOONWELL, wallet) as any;

    console.log(`Проверяем наличие свободных средств в пуле Moonwell для ${underlyingSymbol}...`);
    const poolCash: bigint = await mToken.getCash();

    console.log(`Доступно средств в самом пуле протокола: ${ethers.formatUnits(poolCash, decimals)} ${underlyingSymbol}`);

    if (poolCash < borrowAmountWei) {
        throw new Error(`🛑 Отмена транзакции! В пуле Moonwell сейчас физически НЕТ свободных ${underlyingSymbol} для выдачи займа. Пул пуст (0 Cash).`);
    }

    try {
        console.log(`Отправка транзакции borrow на контракт ${underlyingSymbol} (${mTokenAddress})...`);

        // 2. Вызов borrow
        const tx = await mToken.borrow(borrowAmountWei, { gasLimit: 1500000 });
        console.log(`Транзакция отправлена. Хэш: ${tx.hash}`);
        await tx.wait();

        console.log(`🟢 Заем успешно выполнен!`);
    } catch (err: any) {
        console.error(`Ошибка при исполнении займа в Moonwell:`, err.message);
        throw err;
    }
}




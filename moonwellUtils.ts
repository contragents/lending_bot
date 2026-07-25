import {CONFIG, currentNetwork} from "./config.js";
import {ethers} from 'ethers';
import {withRetry} from "./utils/utils.js";


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







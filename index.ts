import {CONFIG} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';
import * as LIFI from '@lifi/sdk';

// Настройки
const WATCH_ADDRESS = '0x08d01ebaD78C6Dc1DfFC7c244d90C1143E906FEB';
const RPC = CONFIG.NETWORKS[CONFIG.CHAIN].RPC_URL;
const SELL_TOKEN = 'WETH';
const BUY_TOKEN = 'OP';

const provider = new ethers.JsonRpcProvider(RPC);

// Инициализация LI.FI SDK
LIFI.createConfig({
    integrator: 'lifi',
    // здесь можно добавить настройки чейнов, если нужно
});

import { withRetry } from './utils.js'; // Не забываем .js для ESM

async function getMoonwellData() {
    console.log(`--- Moonwell Status (${CONFIG.CHAIN}) ---`);
    const comptroller = new ethers.Contract(CONFIG.NETWORKS[CONFIG.CHAIN!].MOONWELL.COMPTROLLER, CONFIG.ABI.MOONWELL, provider);

    // Возвращает: (error, liquidity, shortfall)
    // Liquidity > 0 означает, что заем безопасен. Shortfall > 0 означает риск ликвидации.
    const [error, liquidity, shortfall] = await withRetry(
        () => comptroller.getAccountLiquidity(WATCH_ADDRESS)
    );

    console.log(`User: ${WATCH_ADDRESS}`);
    console.log(`Available Liquidity (в USD, 1e18): ${ethers.formatEther(liquidity)}`);
    console.log(`Shortfall (Риск): ${ethers.formatEther(shortfall)}`);
}

async function getJumperQuote() {
    console.log(`--- JUMPER (LIFI) Quote (${CONFIG.CHAIN}) ---`);
    try {
        const quoteRequest = {
            fromChain: CONFIG.NETWORKS[CONFIG.CHAIN].ID,
            toChain: CONFIG.NETWORKS[CONFIG.CHAIN].ID,
            fromToken: CONFIG.NETWORKS[CONFIG.CHAIN].TOKENS[SELL_TOKEN],
            toToken: CONFIG.NETWORKS[CONFIG.CHAIN].TOKENS[BUY_TOKEN],
            fromAmount: '1000000000000000000', // 1 ETH
            fromAddress: WATCH_ADDRESS,
            slippage: 0.005, // 0.5%
            order: 'CHEAPEST', // Принудительно искать самый дешевый вариант
            insurance: false,  // Отключить страховку, если она включена по умолчанию
        };

        const quote = await LIFI.getQuote(quoteRequest);
        // Для USDC указываем 6 знаков
        const formattedAmount = formatUnits(quote.estimate.toAmount, 6);
        const formattedAmountMin = formatUnits(quote.estimate.toAmountMin, 6);

        //console.dir(quote.estimate, {depth: null});

        console.log(`Лучший маршрут: ${quote.tool}`);
        console.log(`Вы получите (LIFI): ${formattedAmount}/${formattedAmountMin} USDC`);
    } catch (error) {
        console.error('Ошибка получения котировки:', error);
    }
}


async function get0xQuoteV2(amountInEth: string) {
    console.log(`--- 0x API v2 Quote (CONFIG.CHAIN) ---`);

    const currentNetwork = CONFIG.NETWORKS[CONFIG.CHAIN];
    const amountInWei = ethers.parseEther(amountInEth).toString();

    // Параметры согласно документации v2
    const params = new URLSearchParams({
        chainId: CONFIG.NETWORKS[CONFIG.CHAIN].ID, // Optimism
        sellToken: currentNetwork.TOKENS[SELL_TOKEN], // ETH
        buyToken: currentNetwork.TOKENS[BUY_TOKEN],
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
        console.log(`Вы получите (0x): ${ethers.formatUnits(data.buyAmount, 6)}/${ethers.formatUnits(data.minBuyAmount, 6)} USDC`);

        // console.dir(data, {depth: null});

        return data;

    } catch (error: any) {
        // Если fetch failed, смотрим причину (cause)
        console.error('Ошибка сети:', error.message);
        if (error.cause) console.error('Причина:', error.cause);
    }
}


// Вызов в main():
// await

import { loadWallet } from './utils.js'; // Не забываем .js для ESM
async function main() {
    const wallet = await loadWallet(provider);

    await getMoonwellData();
    await getJumperQuote();
    get0xQuoteV2("1.0");
}

main();

import {CONFIG, getEnv, LENDING, POOLS} from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';
import * as LIFI from '@lifi/sdk';

// Настройки
const WATCH_ADDRESS = '0x08d01ebaD78C6Dc1DfFC7c244d90C1143E906FEB';
const RPC = CONFIG.NETWORKS[CONFIG.CHAIN].RPC_URL;
const SELL_TOKEN = 'WETH';
const BUY_TOKEN = 'USDC';//'OP';

const provider = new ethers.JsonRpcProvider(RPC);

// Инициализация LI.FI SDK
LIFI.createConfig({
    integrator: 'lifi',
    // здесь можно добавить настройки чейнов, если нужно
});

import {withRetry} from './utils.js'; // Не забываем .js для ESM

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

async function getMoonwellPositions() {
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
        params.set('lending_id', LENDING[CONFIG.CHAIN][tgId].ID);
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
                params.set('supply_' + LENDING[CONFIG.CHAIN][tgId].PAIR_IDS[underlyingSymbol], formattedSupply);
            }

            // 4. Расчет баланса долга (Borrow Balance)
            if (borrowBalance > 0n) {
                const formattedBorrow = formatUnits(borrowBalance, CONFIG.TOKEN_DECIMALS[underlyingSymbol]);
                console.log(`🔴 Заем (Liability)   -> ${formattedBorrow} ${underlyingSymbol}`);
                params.set('borrow_' + LENDING[CONFIG.CHAIN][tgId].PAIR_IDS[underlyingSymbol], formattedBorrow);
            }
        }

        console.log(await fetch(url.href));
    } catch (err: any) {
        console.error("Ошибка при получении позиций Moonwell:", err.message);
    }
}


async function getJumperQuote() {
    console.log(`--- JUMPER (LIFI) Quote (${CONFIG.CHAIN}) ---`);
    try {
        const quoteRequest = {
            fromChain: CONFIG.NETWORKS[CONFIG.CHAIN].ID,
            toChain: CONFIG.NETWORKS[CONFIG.CHAIN].ID,
            fromToken: sellTokenAddr,
            toToken: buyTokenAddr,
            fromAmount: '1000000000000000000', // 1 ETH
            fromAddress: WATCH_ADDRESS,
            slippage: 0.005, // 0.5%
            order: 'CHEAPEST', // Принудительно искать самый дешевый вариант
            insurance: false,  // Отключить страховку, если она включена по умолчанию
        };

        const quote = await withRetry<string>(() => LIFI.getQuote(quoteRequest));
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


async function get0xQuoteV2(amountInEth: string) {
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

async function getUniswapPoolPrice(provider: ethers.JsonRpcProvider) {
    const poolEthOp005Address = "0xFC1f3296458F9b2a27a0B91dd7681C4020E09D05"; // Пул 0.05%
    const poolEthOp03Address = "0x68F5C0A2DE713a54991E01858Fd27a3832401849"; // Пул 0.3%

    const poolContract = new ethers.Contract(poolEthOp03Address, CONFIG.ABI.UNISWAP, provider);

    // Получаем текущий слепок пула (без затрат газа)
    const [sqrtPriceX96, tick] = await poolContract.slot0();

    // Математика Uniswap V3 для расчета цены из tick
    // Цена ETH относительно OP = 1.0001 ^ tick
    const priceETHinOP = Math.pow(1.0001, Number(tick));

    console.log(`--- Uniswap V3 Pool (ETH/OP) ---`);
    console.log(`Текущая цена 1 ETH = ${priceETHinOP.toFixed(6)} OP`);

    return priceETHinOP;
}

import {loadWallet} from './utils.js'; // Не забываем .js для ESM
import {estimatePriceImpact} from './utils.js';

const wallet = await loadWallet(provider);
const currentNetwork = CONFIG.NETWORKS[CONFIG.CHAIN];
const sellTokenAddr = currentNetwork.TOKENS[SELL_TOKEN]; // ETH
const buyTokenAddr = currentNetwork.TOKENS[BUY_TOKEN];

async function main() {

    await getMoonwellData(); // Общий статус
    await getMoonwellPositions(); // Детальный список позиций

    await getJumperQuote();
    await get0xQuoteV2("1.0");
    if(CONFIG.CHAIN === 'OPT') {
        await getUniswapPoolPrice(provider);
        await estimatePriceImpact(provider, 10000, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
        await estimatePriceImpact(provider, 10000, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
    }
}

main();

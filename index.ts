import { CONFIG } from './config.js'; // Важно: в ESM нужно указывать .js
import {ethers, formatUnits} from 'ethers';
import * as LIFI from '@lifi/sdk';

// Настройки
const WATCH_ADDRESS = '0x08d01ebaD78C6Dc1DfFC7c244d90C1143E906FEB';
const RPC = CONFIG.RPC.BASE;




// Инициализация LI.FI SDK
LIFI.createConfig({
    integrator: 'lifi',
    // здесь можно добавить настройки чейнов, если нужно
});

console.log('SDK сконфигурирован');

// 2. Пример использования функции (вместо lifi.getRoutes)
async function checkRoutes() {
    try {
        // Все функции теперь доступны напрямую из пакета
        // const routes = await LIFI.getRoutes(routeOptions);
        console.log('Доступные функции проверены');
    } catch (e) {
        console.error(e);
    }
}

async function getMoonwellData() {
    console.log('--- Moonwell Status (Base) ---');
    const comptroller = new ethers.Contract(CONFIG.MOONWELL[CONFIG.CHAIN!].COMPTROLLER, CONFIG.MOONWELL.ABI, provider);

    // Возвращает: (error, liquidity, shortfall)
    // Liquidity > 0 означает, что заем безопасен. Shortfall > 0 означает риск ликвидации.
    const [error, liquidity, shortfall] = await comptroller.getAccountLiquidity(WATCH_ADDRESS);

    console.log(`User: ${WATCH_ADDRESS}`);
    console.log(`Available Liquidity (в USD, 1e18): ${ethers.formatEther(liquidity)}`);
    console.log(`Shortfall (Риск): ${ethers.formatEther(shortfall)}`);
}

async function getJumperQuote() {
    console.log('--- Jumper (LI.FI) Quote ---');
    try {
        const quoteRequest = {
            fromChain: 8453,//'BAS', // или ID сети, например 8453
            toChain: 8453,//'OPT',   // или ID сети, например 10
            fromToken: 'ETH',
            toToken: 'USDC',
            fromAmount: '1000000000000000000', // 0.01 ETH
            fromAddress: WATCH_ADDRESS,
            slippage: 0.005, // 0.5%
            order: 'CHEAPEST', // Принудительно искать самый дешевый вариант
            insurance: false,  // Отключить страховку, если она включена по умолчанию
        };

        // Замените lifi.getQuote на LIFI.getQuote
        const quote = await LIFI.getQuote(quoteRequest);
        // Для USDC указываем 6 знаков
        const formattedAmount = formatUnits(quote.estimate.toAmount, 6);
        const formattedAmountMin = formatUnits(quote.estimate.toAmountMin, 6);

        console.dir(quote.estimate, { depth: null });

        console.log(`Лучший маршрут: ${quote.tool}`);
        console.log(`Вы получите: ${formattedAmount}/${formattedAmountMin} USDC`);
    } catch (error) {
        console.error('Ошибка получения котировки:', error);
    }
}

import readline from 'readline/promises';
async function loadWallet(provider: ethers.Provider) {
    const keystoreJson = process.env.ENCRYPTED_KEY;
    let password;
    if(process.env.KEY_PASSWORD) {
        password = process.env.KEY_PASSWORD;
    } else {
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
        throw new Error("Неверный пароль!");
    }
}

async function main() {

    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = loadWallet(provider);

    await getMoonwellData();
    await getJumperQuote();
}

main();

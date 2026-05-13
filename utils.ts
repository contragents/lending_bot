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

import {ethers} from 'ethers';
import readline from 'readline/promises';
export async function loadWallet(provider: ethers.Provider) {
    const keystoreJson = process.env.ENCRYPTED_KEY;
    let password;
    if (process.env.KEY_PASSWORD) {
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
        console.log("Неверный пароль!");

        return;
    }
}

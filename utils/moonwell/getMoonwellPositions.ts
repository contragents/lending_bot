import {CONFIG, currentNetwork, getEnv, LENDING, provider, WATCH_ADDRESS} from "../../config.js";
import {ethers, formatUnits} from "ethers";
import {withRetry} from "../utils.js";

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
import {CONFIG, MOONWELL_MARKETS, type SupportedToken} from "../../config.js";
import {ethers} from "ethers";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";

export async function borrowMoonwellAsset(
	underlyingSymbol: SupportedToken,
	amountHuman: number
): Promise<boolean> {
	console.log(`--- Moonwell Borrow Initialization (${CONFIG.CHAIN}) ---`);

	// Проверяем, авторизован ли кошелек
	if (!wallet) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}

	try {
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

		console.log(`Отправка транзакции borrow на контракт ${underlyingSymbol} (${mTokenAddress})...`);

		// 2. Вызов borrow
		const tx = await mToken.borrow(borrowAmountWei, {gasLimit: 1500000});
		console.log(`Транзакция отправлена. Хэш: ${tx.hash}`);

		const receipt = await tx.wait();
		if (!receipt || receipt.status !== 1) {
			throw new Error("Транзакция упала на уровне блокчейна (Revert)");
		}

		await reportGasSpent(receipt);

		// Константный хэш события Borrow(address borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)
		// Мы взяли его напрямую из успешного лога вашей транзакции (индекс 58)
		const BORROW_EVENT_TOPIC = "0x13ed6866d4e1ee6da46f845c46d7e54120883d75c5ea9a2dacc1c4ca8984ab80";

		// Проверяем, есть ли этот хэш в Topic 0 хотя бы одного лога от нашего mToken контракта
		const hasBorrowLog = receipt.logs.some((log: any) =>
			log.address.toLowerCase() === mTokenAddress.toLowerCase() &&
			log.topics && log.topics[0] === BORROW_EVENT_TOPIC
		);

		if (!hasBorrowLog) {
			throw new Error("❌ Ошибка Moonwell: статус транзакции Success, но событие Borrow не найдено (заем отклонен протоколом)!");
		}

		console.log(`🟢 Заем успешно выполнен и верифицирован по нативному топику Borrow!`);
		return true;
	} catch (err: any) {
		console.error(`Ошибка при исполнении займа в Moonwell:`, err.message);

		await reportErrorGasSpent(err);

		return false
	}
}